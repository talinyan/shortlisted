import type { FastifyRequest } from 'fastify';
import { callLlm, documentContent } from '../llm.ts';

const MONTH_PATTERN = '^[0-9]{4}-(0[1-9]|1[0-2])$';
const MONTH_OR_PRESENT_PATTERN = '^([0-9]{4}-(0[1-9]|1[0-2])|present)$';
const JOB_TYPE_CATEGORIES = ['professional', 'internship'] as const;
const CURRENCY_CATEGORIES = ['unknown', 'CAD', 'USD'] as const;
const SKILL_CATEGORIES = [
	'language',
	'framework',
	'tool',
	'database',
	'cloud',
	'education',
	'certification',
	'other'
] as const;
const WORKPLACE_TYPES = ['unknown', 'onsite', 'hybrid', 'remote'] as const;

const REQUIRED_SKILL_FACTOR = 4;
const INTERNSHIP_WEIGHT = 0.5;
const YOE_WEIGHT = 0.5;
const SKILLS_WEIGHT = 0.5;

type Month = '01' | '02' | '03' | '04' | '05' | '06' | '07' | '08' | '09' | '10' | '11' | '12';
type YearMonth = `${number}-${Month}`;
type YearMonthOrPresent = YearMonth | 'present';

type JobType = (typeof JOB_TYPE_CATEGORIES)[number];
type Currency = (typeof CURRENCY_CATEGORIES)[number];
type SkillCategory = (typeof SKILL_CATEGORIES)[number];
type WorkplaceType = (typeof WORKPLACE_TYPES)[number];

const skillsByCategorySchema = {
	type: 'object',
	properties: Object.fromEntries(SKILL_CATEGORIES.map((c) => [c, { type: 'array', items: { type: 'string' } }])),
	required: [...SKILL_CATEGORIES]
};

type SkillsByCategory = Record<SkillCategory, string[]>;

// info extracted from the resume
type ResumeInfo = {
	isResume: boolean;
	candidateName: string;
	candidateLocation: string;
	education: {
		degree: string;
		institution: string;
		start: YearMonth;
		end: YearMonthOrPresent;
	}[];
	jobs: {
		title: string;
		company: string;
		type: JobType;
		start: YearMonth;
		end: YearMonthOrPresent;
	}[];
	skills: SkillsByCategory;
	matchedRequired: string[];
	matchedPreferred: string[];
};

// info extracted from the job posting
type JobInfo = {
	jobTitle: string;
	companyName: string;
	location: string;
	workplaceType: WorkplaceType;
	minSalary: number;
	maxSalary: number;
	currency: Currency;
	minYoe: number;
	requiredSkills: SkillsByCategory;
	preferredSkills: SkillsByCategory;
};

type ScoreBreakdown = {
	score: number;
	yoe?: { required: number; candidate: number; pct: number };
	skills?: { pct: number; matched: string[]; missingRequired: string[]; missingPreferred: string[] };
};

const getJobInfo = async (posting: string): Promise<JobInfo> => {
	const instructions = `
  Read the job posting below and list what a candidate needs:
- jobTitle: the job title.
- companyName: the companies name.
- location: the job location, empty if not listed.
- workplaceType: the workplace type of the job, "unknown" if not listed.
- minSalary: the job minimum salary range. 0 if not listed; if only flat salary listed, use this value;
- maxSalary: the job maximum salary range. 0 if not listed; if only flat salary listed, use this value;
- currency: the currency of the job salary; unknown if not listed
- minYoe: the minimum years of professional experience asked for. If a range is given, use the lower number. Use 0 if none is stated.
- requiredSkills: each distinct programming language, framework, tool, database, cloud platform, degree or certification the posting requires, grouped by category.
- preferredSkills: the same, for items described as preferred, nice to have, a bonus or a plus.
  - Put each item in only one list. Use an empty list for categories with none.
  - Use short, standard names ("Python", "AWS", "Bachelor's in Computer Science"), one item per thing. Split lists like "Python/Go" into separate items.
  - Do not include years of experience, soft skills (communication, teamwork, quality, reliability, etc) or company perks.

Job posting:
"""
${posting}
"""
Respond with minified JSON on a single line, no indentation.`;

	const schema = {
		type: 'object',
		properties: {
			jobTitle: { type: 'string' },
			companyName: { type: 'string' },
			location: { type: 'string' },
			workplaceType: { type: 'string', enum: WORKPLACE_TYPES },
			minSalary: { type: 'integer', minimum: 0 },
			maxSalary: { type: 'integer', minimum: 0 },
			currency: { type: 'string', enum: CURRENCY_CATEGORIES },
			minYoe: { type: 'integer', minimum: 0 },
			requiredSkills: skillsByCategorySchema,
			preferredSkills: skillsByCategorySchema
		},
		required: [
			'jobTitle',
			'companyName',
			'location',
			'workplaceType',
			'minSalary',
			'maxSalary',
			'currency',
			'minYoe',
			'requiredSkills',
			'preferredSkills'
		]
	};

	const jobInfo: JobInfo = await callLlm(instructions, { schema, maxTokens: 2000 });
	return jobInfo;
};

type JobRequirements = {
	minYoe: number;
	requiredSkills: string[];
	preferredSkills: string[];
};

const matchItemsSchema = (skills: string[]) =>
	skills.length > 0 ? { type: 'string', enum: [...new Set(skills)] } : { type: 'string' };

const getResumeInfo = async (file: string, jobRequirements: JobRequirements): Promise<ResumeInfo> => {
	const instructions = `You are a resume screener. Decide whether the document is a resume or CV. If it is not, set isResume to false, leave candidateName and candidateLocation blank, and return empty education, jobs, matchedRequired and matchedPreferred lists, and every skills category empty.
If it is a resume:
- candidateName: the candidate's name, or empty if not shown.
- candidateLocation: the candidate's location, or empty if not shown.
- education: every degree, diploma or program listed. start is the start date as YYYY-MM; if only a year is given, use 01. end is the graduation date as YYYY-MM, exactly as written (including expected dates). Use "present" only if no end date is given and it is ongoing.
- jobs: every work role listed, not education. Give start and end dates as YYYY-MM, exactly as written on the resume. Use "present" as the end for current roles. If only a year is given, use 01 for a start date and 12 for an end date.
  - type is "internship" if the role is described as an internship, co-op, work term, placement, practicum or student position. Otherwise it is "professional".
- skills: every skill found, grouped by category. Use an empty list for categories with none.
  - a skill is a known skill, whether it be a programming language, framework, or anything technology related
  - for example, CSS, C++, HTML, React, GitHub, Golang, etc.
  - One item per skill. Split combined entries like "C/C++" or "HTML/CSS" into separate items.
- matchedRequired: the required skills below that the candidate clearly has, from their skills, jobs or education.
- matchedPreferred: the preferred skills below that the candidate clearly has, from their skills, jobs or education.
  - Count equivalents as a match (Golang = Go, Postgres = PostgreSQL, JS = JavaScript).
  - A combined entry like "C/C++" means the candidate has each of them.
  - For degrees, consider Bachelors of Computing, SWE, and CS equivalent.
  - Use the exact spelling from the lists below. Do not include skills the candidate does not have.

Required skills: ${jobRequirements.requiredSkills.join(',')}
Preferred skills: ${jobRequirements.preferredSkills.join(',')}

Do not judge whether dates are in the past or future; just copy them.
Respond with minified JSON on a single line, no indentation.
`;

	const schema = {
		type: 'object',
		properties: {
			isResume: { type: 'boolean' },
			candidateName: { type: 'string' },
			candidateLocation: { type: 'string' },
			education: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						degree: { type: 'string' },
						institution: { type: 'string' },
						start: { type: 'string', pattern: MONTH_PATTERN },
						end: { type: 'string', pattern: MONTH_OR_PRESENT_PATTERN }
					},
					required: ['degree', 'institution', 'start', 'end']
				}
			},
			jobs: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						title: { type: 'string' },
						company: { type: 'string' },
						type: { type: 'string', enum: JOB_TYPE_CATEGORIES },
						start: { type: 'string', pattern: MONTH_PATTERN },
						end: { type: 'string', pattern: MONTH_OR_PRESENT_PATTERN }
					},
					required: ['title', 'company', 'type', 'start', 'end']
				}
			},
			skills: skillsByCategorySchema,
			matchedRequired: { type: 'array', items: matchItemsSchema(jobRequirements.requiredSkills) },
			matchedPreferred: { type: 'array', items: matchItemsSchema(jobRequirements.preferredSkills) }
		},
		required: [
			'isResume',
			'candidateName',
			'candidateLocation',
			'education',
			'jobs',
			'skills',
			'matchedRequired',
			'matchedPreferred'
		]
	};

	const content = await documentContent(instructions, file);
	const resumeInfo: ResumeInfo = await callLlm(content, { schema, maxTokens: 2000 });
	return resumeInfo;
};

const computeScore = (
	jobReqs: JobRequirements,
	resumeInfo: ResumeInfo,
	yoeWeight: number,
	skillsWeight: number,
	requiredSkillFactor: number
): ScoreBreakdown => {
	const calculateYoe = (jobs: ResumeInfo['jobs']): number => {
		const toMonthIndex = (ym: YearMonth): number => {
			const [y, m] = ym.split('-').map(Number);
			return y * 12 + (m - 1);
		};

		const now = new Date();
		const nowIndex = now.getFullYear() * 12 + now.getMonth();

		// half-open [start, end) month intervals, end month inclusive
		const toIntervals = (list: ResumeInfo['jobs']): [number, number][] =>
			list
				.map((job): [number, number] => {
					const start = toMonthIndex(job.start);
					const end = job.end === 'present' ? nowIndex : Math.min(toMonthIndex(job.end), nowIndex);
					return [start, end + 1];
				})
				.filter(([start, end]) => end > start)
				.sort((a, b) => a[0] - b[0]);

		const mergedMonths = (intervals: [number, number][]): number => {
			if (intervals.length === 0) return 0;

			let totalMonths = 0;
			let [curStart, curEnd] = intervals[0];

			for (const [start, end] of intervals.slice(1)) {
				if (start <= curEnd) {
					curEnd = Math.max(curEnd, end);
				} else {
					totalMonths += curEnd - curStart;
					[curStart, curEnd] = [start, end];
				}
			}
			totalMonths += curEnd - curStart;

			return totalMonths;
		};

		const allMonths = mergedMonths(toIntervals(jobs));
		const professionalMonths = mergedMonths(toIntervals(jobs.filter((job) => job.type === 'professional')));
		const internshipOnlyMonths = allMonths - professionalMonths;

		return (professionalMonths + internshipOnlyMonths * INTERNSHIP_WEIGHT) / 12;
	};

	const requiredYears = jobReqs.minYoe;
	const candidateYears = calculateYoe(resumeInfo.jobs);

	const required = [...new Set(jobReqs.requiredSkills)];
	const requiredSet = new Set(required);
	const preferred = [...new Set(jobReqs.preferredSkills)].filter((s) => !requiredSet.has(s));
	const matchedSet = new Set([...resumeInfo.matchedRequired, ...resumeInfo.matchedPreferred]);

	const matchedRequired = required.filter((s) => matchedSet.has(s));
	const matchedPreferred = preferred.filter((s) => matchedSet.has(s));
	const missingRequired = required.filter((s) => !matchedSet.has(s));
	const missingPreferred = preferred.filter((s) => !matchedSet.has(s));

	if (!resumeInfo.isResume) {
		return { score: 0 };
	}

	const yw = Math.max(0, Number(yoeWeight) || 0);
	const sw = Math.max(0, Number(skillsWeight) || 0);
	const totalWeight = yw + sw || 1;

	const yearsPct = (requiredYears > 0 ? Math.min(1, candidateYears / requiredYears) : 1) * 100;

	const possible = required.length * requiredSkillFactor + preferred.length;
	const skillsPct =
		(possible > 0 ? (matchedRequired.length * requiredSkillFactor + matchedPreferred.length) / possible : 1) * 100;

	const score = Number(((yearsPct * yw + skillsPct * sw) / totalWeight / 10).toFixed(1));

	return {
		score,
		yoe: { required: requiredYears, candidate: Number(candidateYears.toFixed(1)), pct: yearsPct },
		skills: {
			pct: skillsPct,
			matched: [...matchedRequired, ...matchedPreferred],
			missingRequired,
			missingPreferred
		}
	};
};

const getSummary = async (jobInfo: JobInfo, resumeInfo: ResumeInfo, breakdown: ScoreBreakdown): Promise<string> => {
	const instructions = `You are a resume screener. Write a 2-3 sentence summary of how this candidate compares against the job. Use only the facts below, and keep the tone consistent with the score.

Job title: ${jobInfo.jobTitle}
Score: ${breakdown.score}/10
Years of professional experience: ${breakdown.yoe!.candidate} (required: ${breakdown.yoe!.required})
Matched skills: ${breakdown.skills!.matched.join(',') || 'none'}
Missing required skills: ${breakdown.skills!.missingRequired.join(',') || 'none'}
Missing preferred skills: ${breakdown.skills!.missingPreferred.join(',') || 'none'}
Education: ${resumeInfo.education.map((e) => `${e.degree} (${e.institution})`).join(', ') || 'none listed'}

Respond with minified JSON on a single line, no indentation.`;

	const schema = {
		type: 'object',
		properties: { summary: { type: 'string' } },
		required: ['summary']
	};

	const result: { summary: string } = await callLlm(instructions, { schema, maxTokens: 500 });
	return result.summary;
};

type ResumeRequest = FastifyRequest<{
	Body: { prompt: string; file: string; yoeWeight?: number; skillsWeight?: number; requiredSkillFactor?: number };
}>;

export const resumeMatchSchema = {
	body: {
		type: 'object',
		required: ['prompt', 'file'],
		properties: {
			prompt: { type: 'string', minLength: 1, maxLength: 20000 },
			file: { type: 'string', pattern: '^data:(image/(png|jpeg|webp)|application/pdf);base64,' },
			yoeWeight: { type: 'number', minimum: 0, maximum: 1 },
			skillsWeight: { type: 'number', minimum: 0, maximum: 1 },
			requiredSkillFactor: { type: 'number', minimum: 1, maximum: 5 }
		},
		dependencies: {
			yoeWeight: ['skillsWeight'],
			skillsWeight: ['yoeWeight']
		}
	}
};

export default async function resumeMatch(req: ResumeRequest) {
	const { prompt, file, yoeWeight, skillsWeight, requiredSkillFactor } = req.body ?? {};

	const yw = yoeWeight ?? YOE_WEIGHT;
	const sw = skillsWeight ?? SKILLS_WEIGHT;
	const rsf = requiredSkillFactor ?? REQUIRED_SKILL_FACTOR;

	if (Math.abs(yw + sw - 1) > 1e-9) return { error: 'Weights must sum to 1.' };

	const jobInfo = await getJobInfo(prompt);
	const jobRequirements = {
		minYoe: jobInfo.minYoe,
		requiredSkills: Object.values(jobInfo.requiredSkills).flat(),
		preferredSkills: Object.values(jobInfo.preferredSkills).flat()
	};

	const resumeInfo = await getResumeInfo(file, jobRequirements);
	const score = computeScore(jobRequirements, resumeInfo, yw, sw, rsf);

	let summary = 'Not a resume.';
	if (resumeInfo.isResume) {
		summary = resumeInfo.isResume ? await getSummary(jobInfo, resumeInfo, score) : '';
	}

	return { jobInfo, resumeInfo, score, summary };
}
