import Fastify from 'fastify';
import cors from '@fastify/cors';
import resumeMatch, { resumeMatchSchema } from './api/resumeMatch.ts';

export async function buildApp({ logger = true } = {}) {
	const app = Fastify({ logger, bodyLimit: 10 * 1024 * 1024 });

	await app.register(cors, {
		origin: ['https://shortlisted.talinya.ca', /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/]
	});

	app.post('/resume-match', { schema: resumeMatchSchema, bodyLimit: 10 * 1024 * 1024 }, resumeMatch);
	return app;
}
