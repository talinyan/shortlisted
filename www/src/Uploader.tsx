import { useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';

const API = import.meta.env.DEV ? '/api' : 'https://shortlisted-api.talinya.ca';

/** 'YYYY-MM', or 'present' for something still ongoing. */
type YearMonth = string;

type Currency = 'unknown' | 'CAD' | 'USD';
type Workplace = 'unknown' | 'onsite' | 'hybrid' | 'remote';

type MatchResult = {
	jobInfo: {
		jobTitle: string;
		companyName: string;
		location: string;
		workplaceType: Workplace;
		minSalary: number;
		maxSalary: number;
		currency: Currency;
		minYoe: number;
	};
	resumeInfo: {
		isResume: boolean;
		candidateName: string;
		candidateLocation: string;
		education: { degree: string; institution: string; start: YearMonth; end: YearMonth }[];
		jobs: { title: string; company: string; type: 'professional' | 'internship'; start: YearMonth; end: YearMonth }[];
	};
	score: {
		score: number;
		yoe?: { required: number; candidate: number; pct: number };
		skills?: { pct: number; matched: string[]; missingRequired: string[]; missingPreferred: string[] };
	};
	summary: string;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const WORKPLACE_LABELS: Record<Workplace, string> = {
	onsite: 'On-site',
	hybrid: 'Hybrid',
	remote: 'Remote',
	unknown: 'Not listed'
};

// Must match the file pattern in the API's request schema.
const ACCEPTED_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const isAcceptedFile = (file: File) => ACCEPTED_TYPES.includes(file.type);

function readAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

function formatMonth(value: YearMonth) {
	if (value === 'present') return 'Present';
	const [year, month] = value.split('-').map(Number);
	if (!year) return '';
	return MONTHS[month - 1] ? `${MONTHS[month - 1]} ${year}` : String(year);
}

const formatRange = (start: YearMonth, end: YearMonth) =>
	[formatMonth(start), formatMonth(end)].filter(Boolean).join(' – ');

function formatSalary(min: number, max: number, currency: Currency) {
	if (!min && !max) return 'Not listed';
	const format = (n: number) =>
		currency === 'unknown'
			? n.toLocaleString('en-CA')
			: n.toLocaleString('en-CA', { style: 'currency', currency, maximumFractionDigits: 0 });
	if (!min || !max || min === max) return format(min || max);
	return `${format(min)} – ${format(max)}`;
}

const roundYears = (n: number) => Math.round(n * 10) / 10;
const formatYears = (n: number) => `${roundYears(n)} ${roundYears(n) === 1 ? 'year' : 'years'}`;

const clampPct = (n: number) => Math.max(0, Math.min(100, n));

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section>
			<h3 className='mb-4 text-lg font-semibold text-neutral-100'>{title}</h3>
			{children}
		</section>
	);
}

function Meter({ label, detail, pct }: { label: string; detail: string; pct: number }) {
	return (
		<div>
			<div className='flex items-baseline justify-between gap-4'>
				<span className='text-neutral-200'>{label}</span>
				<span className='text-sm tabular-nums text-neutral-400'>{detail}</span>
			</div>
			<div className='mt-2 h-1.5 rounded-full bg-neutral-800' aria-hidden>
				<div className='h-full rounded-full bg-primary' style={{ width: `${clampPct(pct)}%` }} />
			</div>
		</div>
	);
}

const SKILL_TONES = {
	matched: 'border-emerald-400/70',
	required: 'border-rose-400/80',
	preferred: 'border-neutral-600'
};

function SkillGroup({ title, skills, tone }: { title: string; skills: string[]; tone: keyof typeof SKILL_TONES }) {
	return (
		<div className={`border-l-2 pl-4 ${SKILL_TONES[tone]}`}>
			<h4 className='text-sm font-medium text-neutral-200'>
				{title} <span className='font-normal tabular-nums text-neutral-500'>{skills.length}</span>
			</h4>
			{skills.length === 0 ? (
				<p className='mt-2 text-sm text-neutral-500'>None</p>
			) : (
				<ul className='mt-2 space-y-1 text-sm text-neutral-300'>
					{skills.map((skill) => (
						<li key={skill}>{skill}</li>
					))}
				</ul>
			)}
		</div>
	);
}

function DatedList({
	items,
	empty
}: {
	items: { key: string; title: string; subtitle: string; dates: string }[];
	empty: string;
}) {
	if (items.length === 0) return <p className='text-neutral-500'>{empty}</p>;

	return (
		<ul className='space-y-4'>
			{items.map((item) => (
				<li key={item.key} className='flex flex-col gap-x-6 sm:flex-row sm:items-baseline sm:justify-between'>
					<div>
						<p className='text-neutral-100'>{item.title}</p>
						<p className='text-sm text-neutral-400'>{item.subtitle}</p>
					</div>
					<p className='shrink-0 text-sm tabular-nums text-neutral-500'>{item.dates}</p>
				</li>
			))}
		</ul>
	);
}

function Results({ data }: { data: MatchResult }) {
	const { jobInfo, resumeInfo, score, summary } = data;
	const headingRef = useRef<HTMLHeadingElement>(null);

	// Move focus to the new results so they scroll into view and screen readers announce them.
	useEffect(() => {
		headingRef.current?.focus();
	}, [data]);

	if (!resumeInfo.isResume) {
		return (
			<div>
				<h2 ref={headingRef} tabIndex={-1} className='text-xl font-semibold text-neutral-100 outline-none'>
					This file doesn't look like a resume
				</h2>
				<p className='mt-2 text-neutral-400'>Upload a resume or CV, then check the match again.</p>
			</div>
		);
	}

	const role = [jobInfo.jobTitle || 'this role', jobInfo.companyName].filter(Boolean).join(' at ');

	const jobDetails: [string, string][] = [
		['Location', jobInfo.location || 'Not listed'],
		['Workplace', WORKPLACE_LABELS[jobInfo.workplaceType]],
		['Salary', formatSalary(jobInfo.minSalary, jobInfo.maxSalary, jobInfo.currency)],
		['Experience required', jobInfo.minYoe ? `${roundYears(jobInfo.minYoe)}+ years` : 'None listed']
	];

	return (
		<div className='space-y-12'>
			<header className='flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-8'>
				<p className='shrink-0 text-6xl font-semibold leading-none tracking-tight tabular-nums text-primary'>
					<span className='sr-only'>Match score: </span>
					{score.score.toFixed(1)}
					<span className='text-2xl font-normal text-neutral-500'>/10</span>
				</p>
				<div>
					<h2 ref={headingRef} tabIndex={-1} className='text-xl font-semibold text-neutral-100 outline-none'>
						{resumeInfo.candidateName || 'This candidate'} for {role}
					</h2>
					<p className='mt-2 leading-relaxed text-neutral-300'>{summary}</p>
				</div>
			</header>

			{(score.yoe || score.skills) && (
				<Section title='Score breakdown'>
					<div className='space-y-5'>
						{score.yoe && (
							<Meter
								label='Experience'
								detail={
									score.yoe.required
										? `${roundYears(score.yoe.candidate)} of ${formatYears(score.yoe.required)}`
										: `${formatYears(score.yoe.candidate)}, no minimum`
								}
								pct={score.yoe.pct}
							/>
						)}
						{score.skills && (
							<Meter label='Skills' detail={`${Math.round(score.skills.pct)}%`} pct={score.skills.pct} />
						)}
					</div>
				</Section>
			)}

			{score.skills && (
				<Section title='Skills'>
					<div className='grid gap-6 sm:grid-cols-3'>
						<SkillGroup title='Matched' skills={score.skills.matched} tone='matched' />
						<SkillGroup title='Missing, required' skills={score.skills.missingRequired} tone='required' />
						<SkillGroup title='Missing, nice to have' skills={score.skills.missingPreferred} tone='preferred' />
					</div>
				</Section>
			)}

			<Section title='About the role'>
				<dl className='grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4'>
					{jobDetails.map(([label, value]) => (
						<div key={label}>
							<dt className='text-sm text-neutral-500'>{label}</dt>
							<dd className='mt-0.5 text-neutral-100'>{value}</dd>
						</div>
					))}
				</dl>
			</Section>

			<Section title='Work history'>
				<DatedList
					empty='No work history found in the resume.'
					items={resumeInfo.jobs.map((job) => ({
						key: `${job.company}|${job.title}|${job.start}`,
						title: job.title,
						subtitle: job.type === 'internship' ? `${job.company}, internship` : job.company,
						dates: formatRange(job.start, job.end)
					}))}
				/>
			</Section>

			<Section title='Education'>
				<DatedList
					empty='No education found in the resume.'
					items={resumeInfo.education.map((ed) => ({
						key: `${ed.institution}|${ed.degree}|${ed.start}`,
						title: ed.degree,
						subtitle: ed.institution,
						dates: formatRange(ed.start, ed.end)
					}))}
				/>
			</Section>
		</div>
	);
}

function Uploader() {
	const [posting, setPosting] = useState('');
	const [file, setFile] = useState<File>();
	const [experienceShare, setExperienceShare] = useState(50);
	const [requiredSkillFactor, setRequiredSkillFactor] = useState(4);
	const [dragging, setDragging] = useState(false);
	const [loading, setLoading] = useState(false);
	const [result, setResult] = useState<MatchResult>();
	const [error, setError] = useState('');

	const missing = [!posting.trim() && 'a job posting', !file && 'a resume'].filter(Boolean).join(' and ');
	const canSubmit = !missing && !loading;

	function chooseFile(next: File | undefined) {
		if (!next) return;
		if (!isAcceptedFile(next)) {
			setError(`${next.name} isn't a supported file. Upload the resume as a PDF, PNG, JPEG or WebP.`);
			return;
		}
		setError('');
		setFile(next);
	}

	function handleDrop(e: DragEvent<HTMLLabelElement>) {
		e.preventDefault();
		setDragging(false);
		chooseFile(e.dataTransfer.files[0]);
	}

	async function handleSubmit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (!file || !canSubmit) return;

		setLoading(true);
		setError('');
		setResult(undefined);

		try {
			const res = await fetch(`${API}/resume-match`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					prompt: posting,
					file: await readAsDataUrl(file),
					yoeWeight: experienceShare / 100,
					skillsWeight: 1 - experienceShare / 100,
					requiredSkillFactor
				})
			});
			const data = await res.json().catch(() => undefined);

			if (data?.error) setError(data.error);
			else if (!res.ok || !data) setError(`The match check failed (status ${res.status}). Try again in a moment.`);
			else setResult(data as MatchResult);
		} catch {
			setError("Couldn't reach the server. Check your connection and try again.");
		} finally {
			setLoading(false);
		}
	}

	return (
		<main className='mx-auto max-w-3xl px-5 py-12 text-neutral-300 sm:py-16'>
			<header>
				<h1 className='text-3xl font-semibold tracking-tight text-neutral-50'>Shortlisted</h1>
				<p className='mt-2 text-neutral-400'>Paste a job posting and upload a resume to see how well they match.</p>
			</header>

			<form onSubmit={handleSubmit} aria-busy={loading} className='mt-10 space-y-8'>
				<div>
					<label htmlFor='posting' className='block font-medium text-neutral-100'>
						Job posting
					</label>
					<textarea
						id='posting'
						rows={12}
						value={posting}
						onChange={(e) => setPosting(e.target.value)}
						placeholder='Paste the full posting, including requirements and salary if listed'
						className='mt-2 block w-full resize-y rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 text-sm leading-relaxed text-neutral-100 placeholder:text-neutral-500 focus:border-primary focus:outline-none'
					/>
				</div>

				<div>
					<p className='font-medium text-neutral-100'>Resume</p>
					<label
						onDragOver={(e) => {
							e.preventDefault();
							setDragging(true);
						}}
						onDragLeave={() => setDragging(false)}
						onDrop={handleDrop}
						className={`mt-2 flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-dashed px-4 py-5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary ${
							dragging ? 'border-primary bg-neutral-900' : 'border-neutral-600 hover:border-neutral-400'
						}`}
					>
						<input
							type='file'
							accept={ACCEPTED_TYPES.join(',')}
							className='sr-only'
							onChange={(e) => chooseFile(e.target.files?.[0])}
						/>
						{file ? (
							<>
								<span className='truncate text-neutral-100'>{file.name}</span>
								<span className='shrink-0 text-sm text-neutral-400 underline underline-offset-2'>Replace</span>
							</>
						) : (
							<span className='text-neutral-400'>
								Drop a PDF, PNG, JPEG or WebP here, or{' '}
								<span className='text-neutral-100 underline underline-offset-2'>choose a file</span>
							</span>
						)}
					</label>
				</div>

				<fieldset>
					<legend className='font-medium text-neutral-100'>Scoring</legend>
					<div className='mt-3 grid gap-8 sm:grid-cols-2'>
						<div>
							<label htmlFor='weighting' className='block text-neutral-200'>
								Experience vs skills
							</label>

							<p className='mt-1 text-sm text-neutral-400'>
								How much the score weighs years of experience against skills.
							</p>

							<input
								id='weighting'
								type='range'
								min={0}
								max={100}
								step={5}
								value={experienceShare}
								onChange={(e) => setExperienceShare(Number(e.target.value))}
								aria-valuetext={`${experienceShare}% experience, ${100 - experienceShare}% skills`}
								className='mt-4 w-full accent-primary'
							/>

							<div className='mt-1 flex justify-between text-sm tabular-nums text-neutral-400'>
								<span>Experience {experienceShare}%</span>
								<span>Skills {100 - experienceShare}%</span>
							</div>
						</div>

						<div>
							<label htmlFor='required-skill-factor' className='block text-neutral-200'>
								Required skills
							</label>

							<p className='mt-1 text-sm text-neutral-400'>
								How many times more a required skill counts than a nice-to-have one.
							</p>

							<input
								id='required-skill-factor'
								type='range'
								min={1}
								max={5}
								step={1}
								value={requiredSkillFactor}
								onChange={(e) => setRequiredSkillFactor(Number(e.target.value))}
								aria-valuetext={`Required skills count ${requiredSkillFactor} times as much as nice-to-have skills`}
								className='mt-4 w-full accent-primary'
							/>

							<div className='mt-1 flex justify-between text-sm tabular-nums text-neutral-400'>
								<span>Required {requiredSkillFactor}×</span>
								<span>Nice to have 1×</span>
							</div>
						</div>
					</div>
				</fieldset>

				<div className='flex flex-wrap items-center gap-x-4 gap-y-2'>
					<button
						type='submit'
						disabled={!canSubmit}
						className='rounded-lg bg-primary px-5 py-2.5 font-semibold text-black hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40'
					>
						{loading ? 'Checking match…' : 'Check match'}
					</button>
					{missing && <p className='text-sm text-neutral-500'>Add {missing} to check the match.</p>}
				</div>

				{error && (
					<p role='alert' className='text-sm text-rose-300'>
						{error}
					</p>
				)}
			</form>

			{result && (
				<div className='mt-14 border-t border-neutral-800 pt-12'>
					<Results data={result} />
				</div>
			)}
		</main>
	);
}

export default Uploader;
