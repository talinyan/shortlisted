# Shortlisted
 
Scores how well a resume fits a job posting. A self-hosted LLM reads the documents, and a deterministic algorithm does the scoring, so every score can be explained.
 
**Try it at [shortlisted.talinya.ca](https://shortlisted.talinya.ca)**

## Project structure
 
```
api/
└── src/
    ├── api/resumeMatch.ts   # Extraction schemas, prompts, scoring algorithm, route handler
    ├── llm.ts               # llama.cpp client, PDF-to-text, image handling
    ├── app.ts               # Fastify app, CORS, route registration
    ├── server.ts            # Entry point
    └── tests/               # node:test suite with a mocked LLM
www/
└── src/
    └── Uploader.tsx         # Upload form, scoring sliders, results view
```
