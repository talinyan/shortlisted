import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.ts';

const IMAGE = 'data:image/png;base64,AAAA';

async function post(payload: object) {
	const app = await buildApp({ logger: false });
	const res = await app.inject({ method: 'POST', url: '/resume-match', payload });
	await app.close();
	return res;
}

// simulate LLM returns
function fakeLlm(...answers: object[]) {
	let call = 0;
	return mock.method(globalThis, 'fetch', async () => {
		const answer = answers[call++];
		if (!answer) throw new Error(`Unexpected LLM call #${call}`);
		return Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }] });
	});
}
afterEach(() => mock.restoreAll());

const emptySkills = () => ({
	language: [] as string[],
	framework: [] as string[],
	tool: [] as string[],
	database: [] as string[],
	cloud: [] as string[],
	education: [] as string[],
	certification: [] as string[],
	other: [] as string[]
});

const job = (minYoe: number, required: string[] = [], preferred: string[] = []) => ({
	jobTitle: 'Developer',
	companyName: 'Acme',
	location: '',
	workplaceType: 'unknown',
	minSalary: 0,
	maxSalary: 0,
	currency: 'unknown',
	minYoe,
	requiredSkills: { ...emptySkills(), language: required },
	preferredSkills: { ...emptySkills(), language: preferred }
});

const resume = (
	jobs: { start: string; end: string; type?: 'professional' | 'internship' }[],
	matchedRequired: string[] = [],
	matchedPreferred: string[] = []
) => ({
	isResume: true,
	candidateName: 'Test Person',
	candidateLocation: '',
	education: [],
	jobs: jobs.map((j) => ({ title: 'Dev', company: 'Acme', type: 'professional', ...j })),
	skills: { ...emptySkills(), language: [...matchedRequired, ...matchedPreferred] },
	matchedRequired,
	matchedPreferred
});

const notResume = {
	isResume: false,
	candidateName: '',
	candidateLocation: '',
	education: [],
	jobs: [],
	skills: emptySkills(),
	matchedRequired: [],
	matchedPreferred: []
};

const SUMMARY = { summary: 'Test summary.' };

// Input validation
test('rejects request without file', async () => {
	const res = await post({ prompt: 'Python developer' });
	assert.equal(res.statusCode, 400);
});

test('rejects request without prompt', async () => {
	const res = await post({ file: IMAGE });
	assert.equal(res.statusCode, 400);
});

test('rejects only one weight', async () => {
	const res = await post({ prompt: 'x', file: IMAGE, yoeWeight: 0.5 });
	assert.equal(res.statusCode, 400);
});

test('rejects non-numeric weight', async () => {
	const res = await post({ prompt: 'x', file: IMAGE, yoeWeight: 'a', skillsWeight: 0.5 });
	assert.equal(res.statusCode, 400);
});

test('rejects weights not summing to 1', async () => {
	const res = await post({ prompt: 'x', file: IMAGE, yoeWeight: 0.5, skillsWeight: 0.6 });
	assert.equal(res.json().error, 'Weights must sum to 1.');
});

test('allows 0/1 weights', async () => {
	fakeLlm(job(2, ['Python']), resume([], ['Python']), SUMMARY);
	const res = await post({ prompt: 'Python developer', file: IMAGE, yoeWeight: 0, skillsWeight: 1 });
	assert.equal(res.json().score.score, 10);
});

test('rejects non-numeric required skill factor', async () => {
	const res = await post({ prompt: 'x', file: IMAGE, requiredSkillFactor: 'a' });
	assert.equal(res.statusCode, 400);
});

test('rejects skill factor out of valid range', async () => {
	const res = await post({ prompt: 'x', file: IMAGE, requiredSkillFactor: 100 });
	assert.equal(res.statusCode, 400);
});

// Score validation
test('posting with no requirements gives full credit', async () => {
	const fetchMock = fakeLlm(job(0), resume([]), SUMMARY);
	const res = await post({ prompt: '123', file: IMAGE });

	assert.equal(res.statusCode, 200);
	assert.equal(res.json().score.score, 10);
	assert.equal(fetchMock.mock.callCount(), 3);
});

test('image with no resume returns score 0 and skips summary', async () => {
	const fetchMock = fakeLlm(job(2, ['Python']), notResume);
	const res = await post({ prompt: 'Software Developer requiring Python efficiency', file: IMAGE });
	const body = res.json();

	assert.equal(res.statusCode, 200);
	assert.equal(body.resumeInfo.isResume, false);
	assert.equal(body.score.score, 0);
	assert.equal(body.summary, 'Not a resume.');
	assert.equal(fetchMock.mock.callCount(), 2);
});

test('has experience and has skill = 10/10', async () => {
	fakeLlm(
		job(2, ['Python']),
		resume(
			[{ start: '2022-01', end: '2023-12' }], // 5
			['Python'] // 5
		),
		SUMMARY
	);

	const res = await post({ prompt: 'Python developer', file: IMAGE });
	const body = res.json();

	assert.equal(res.statusCode, 200);
	assert.equal(body.score.score, 10);
	assert.deepEqual(body.score.skills.matched, ['Python']);
	assert.equal(body.summary, 'Test summary.');
});

test('has experience and no skill = 5/10', async () => {
	fakeLlm(
		job(2, ['Python']),
		resume(
			[{ start: '2022-01', end: '2023-12' }], // 5
			[] // 0
		),
		SUMMARY
	);

	const res = await post({ prompt: 'Python developer', file: IMAGE });
	const body = res.json();

	assert.equal(res.statusCode, 200);
	assert.equal(body.score.score, 5);
	assert.deepEqual(body.score.skills.missingRequired, ['Python']);
});

test('no experience and has skill = 5/10', async () => {
	fakeLlm(
		job(2, ['Python']),
		resume(
			[], // 0
			['Python'] // 5
		),
		SUMMARY
	);

	const res = await post({ prompt: 'Python developer', file: IMAGE });

	assert.equal(res.statusCode, 200);
	assert.equal(res.json().score.score, 5);
});

test('no experience and no skills = 0/10', async () => {
	fakeLlm(
		job(2, ['Python']),
		resume(
			[], // 0
			[] // 0
		),
		SUMMARY
	);

	const res = await post({ prompt: 'Python developer', file: IMAGE });

	assert.equal(res.statusCode, 200);
	assert.equal(res.json().score.score, 0);
});

test('has experience and no skill with 75/25 weight = 7.5/10', async () => {
	fakeLlm(
		job(2, ['Python']),
		resume(
			[{ start: '2022-01', end: '2023-12' }], // 5
			[] // 0
		),
		SUMMARY
	);

	const res = await post({ prompt: 'Python developer', file: IMAGE, yoeWeight: 0.75, skillsWeight: 0.25 });
	const body = res.json();

	assert.equal(res.statusCode, 200);
	assert.equal(body.score.score, 7.5);
	assert.deepEqual(body.score.skills.missingRequired, ['Python']);
});

test('no experience and has skill with 25/75 weight = 7.5/10', async () => {
	fakeLlm(
		job(2, ['Python']),
		resume(
			[], // 0
			['Python'] // 5
		),
		SUMMARY
	);

	const res = await post({ prompt: 'Python developer', file: IMAGE, yoeWeight: 0.25, skillsWeight: 0.75 });

	assert.equal(res.statusCode, 200);
	assert.equal(res.json().score.score, 7.5);
});
