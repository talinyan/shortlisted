import { extractText, getDocumentProxy } from 'unpdf';

const LLAMA_API_KEY = process.env.LLAMA_API_KEY ?? '';
const LLAMA_URL = process.env.LLAMA_URL ?? '';

type Model = 'qwen3.6-35b' | 'qwen3.5-9b';
const DEFAULT_MODEL: Model = (process.env.LLAMA_MODEL as Model) ?? 'qwen3.6-35b';

export type LlmContent =
	| string
	| ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];

const MAX_PDF_CHARS = 100_000;

async function pdfDataUrlToText(dataUrl: string): Promise<string> {
	const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
	const pdf = await getDocumentProxy(new Uint8Array(bytes));
	const { text } = await extractText(pdf, { mergePages: true });
	return text.slice(0, MAX_PDF_CHARS);
}

export const documentContent = async (instructions: string, file: string): Promise<LlmContent> => {
	if (file.startsWith('data:image/')) {
		return [
			{ type: 'text', text: instructions },
			{ type: 'image_url', image_url: { url: file } }
		];
	}
	if (file.startsWith('data:application/pdf;base64,')) {
		const text = await pdfDataUrlToText(file);
		if (!text.trim()) throw new Error('PDF has no text (it may be a scanned image).');
		return `${instructions}\n\nDocument:\n"""\n${text}\n"""`;
	}
	throw new Error('Only images and PDFs are supported.');
};

export const callLlm = async (
	content: LlmContent,
	{
		schema,
		maxTokens,
		temperature = 0,
		model = DEFAULT_MODEL
	}: { schema?: object; maxTokens: number; temperature?: number; model?: Model }
) => {
	const body = {
		model,
		messages: [{ role: 'user', content }],
		max_tokens: maxTokens,
		temperature,
		...(schema && { response_format: { type: 'json_schema', json_schema: { schema } } })
	};

	const res = await fetch(LLAMA_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLAMA_API_KEY}` },
		body: JSON.stringify(body)
	});
	if (!res.ok) throw new Error(`LLM request failed (${res.status}): ${await res.text()}`);

	const data = await res.json();
	const t = data.timings;
	console.log(
		`[llm] ${data.model} prompt=${t?.prompt_n}tok/${Math.round(t?.prompt_ms)}ms ` +
			`gen=${t?.predicted_n}tok/${Math.round(t?.predicted_ms)}ms`
	);

	const text: string = data.choices[0].message.content;
	return schema ? JSON.parse(text) : text.trim();
};
