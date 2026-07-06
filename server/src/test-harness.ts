import { getLlmConfig, getLlmProvider, isLlmEnabled, validateLlmStartup } from './llm/provider.js';

async function main() {
  const cfg = getLlmConfig();
  console.log('[test-harness] LLM provider:', cfg.provider);

  if (!isLlmEnabled()) {
    console.log('[test-harness] LLM provider disabled (LLM_PROVIDER=none).');
    console.log('[test-harness] Set LLM_PROVIDER=ollama to run Ollama integration checks.');
    process.exit(0);
  }

  try {
    await validateLlmStartup();
    console.log('[test-harness] Ollama health check passed.');
  } catch (err) {
    console.error('[test-harness] Ollama health check failed:', err);
    process.exit(1);
  }

  const provider = getLlmProvider();
  try {
    const plan = await provider.planToolCalls(
      'Summarize important primary inbox emails from this week',
      [
        { name: 'mail-search', description: 'Search indexed email' },
        { name: 'mail-get', description: 'Fetch a full email body by ID' },
        { name: 'llm-summarize', description: 'Summarize text content' },
      ],
      3
    );
    console.log('[test-harness] Planner check passed:', JSON.stringify({
      provider: plan.provider,
      model: plan.model,
      steps: plan.steps.length,
    }));
  } catch (err) {
    console.error('[test-harness] Planner check failed:', err);
    process.exit(1);
  }

  try {
    const summary = await provider.summarize({
      task: 'Summarize in one sentence',
      content: 'Email from NIH asks for updated budget documents by Friday.',
      maxChars: 300,
    });
    console.log('[test-harness] Summarizer check passed:', JSON.stringify({
      provider: summary.provider,
      model: summary.model,
      chars: summary.summary.length,
    }));
  } catch (err) {
    console.error('[test-harness] Summarizer check failed:', err);
    process.exit(1);
  }

  console.log('[test-harness] All checks passed.');
}

main().catch((err) => {
  console.error('[test-harness] Fatal error:', err);
  process.exit(1);
});
