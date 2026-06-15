import { describe, expect, test } from 'bun:test';
import {
  VllmRecipesClient,
  VllmRecipeValidationError,
  VllmRecipeTimeoutError,
  VllmRecipeUpstreamError,
} from './vllmRecipesClient';

describe('VllmRecipesClient', () => {
  test('resolves relative recipe references under the configured recipe base URL', () => {
    const client = new VllmRecipesClient('https://recipes.vllm.ai/catalog');

    expect(client.resolveReference('microsoft/Phi-4-mini-instruct.json')).toBe(
      'https://recipes.vllm.ai/catalog/microsoft/Phi-4-mini-instruct.json'
    );
  });

  test('allows absolute references inside the configured recipe base URL', () => {
    const client = new VllmRecipesClient('https://recipes.vllm.ai/catalog');

    expect(client.resolveReference('https://recipes.vllm.ai/catalog/microsoft/Phi-4-mini-instruct.json')).toBe(
      'https://recipes.vllm.ai/catalog/microsoft/Phi-4-mini-instruct.json'
    );
  });

  test('rejects recipe references outside the configured recipe origin', () => {
    const client = new VllmRecipesClient('https://recipes.vllm.ai');

    expect(() => client.resolveReference('https://example.com/recipe.json')).toThrow(
      'vLLM recipe references must stay under https://recipes.vllm.ai'
    );
  });

  test('rejects recipe references outside the configured recipe path prefix', () => {
    const client = new VllmRecipesClient('https://recipes.vllm.ai/catalog');

    expect(() => client.resolveReference('/other/recipe.json')).toThrow(
      'vLLM recipe references must stay under https://recipes.vllm.ai/catalog'
    );
  });

  test('rejects non-HTTPS recipe references', () => {
    const client = new VllmRecipesClient('https://recipes.vllm.ai');

    expect(() => client.resolveReference('http://recipes.vllm.ai/recipe.json')).toThrow(
      'vLLM recipe references must use HTTPS'
    );
  });

  describe('getByModelId model ID validation', () => {
    const client = new VllmRecipesClient('https://recipes.vllm.ai');

    // These must throw synchronously from validation, before any network fetch.
    test.each([
      ['extra path segments', 'acme/foo/bar'],
      ['parent-dir traversal in model', 'acme/../bar'],
      ['parent-dir traversal in org', '../acme/model'],
      ['dot segment', './model'],
      ['trailing slash', 'acme/'],
      ['leading slash', '/model'],
      ['no slash', 'justmodel'],
    ])('rejects %s (%p)', async (_label, modelId) => {
      await expect(client.getByModelId(modelId)).rejects.toThrow(
        `Invalid Hugging Face model ID: ${modelId}`
      );
    });

    test('throws a typed validation error for bad input (mapped to 4xx by the route)', async () => {
      await expect(client.getByModelId('acme/foo/bar')).rejects.toBeInstanceOf(VllmRecipeValidationError);
    });
  });

  describe('upstream error classification + caching', () => {
    const originalFetch = globalThis.fetch;

    function withFetch<T>(fetchImpl: typeof fetch, run: (client: VllmRecipesClient) => Promise<T>): Promise<T> {
      globalThis.fetch = fetchImpl;
      const client = new VllmRecipesClient('https://recipes.vllm.ai');
      return run(client).finally(() => {
        globalThis.fetch = originalFetch;
      });
    }

    test('maps an aborted fetch to a timeout error', async () => {
      await withFetch(
        (async () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }) as unknown as typeof fetch,
        async (client) => {
          await expect(client.getByModelId('acme/model')).rejects.toBeInstanceOf(VllmRecipeTimeoutError);
        }
      );
    });

    test('maps a non-ok upstream response to an upstream error', async () => {
      await withFetch(
        (async () => new Response('nope', { status: 503, statusText: 'Service Unavailable' })) as unknown as typeof fetch,
        async (client) => {
          await expect(client.getByModelId('acme/model')).rejects.toBeInstanceOf(VllmRecipeUpstreamError);
        }
      );
    });

    test('rejects an oversized recipe payload', async () => {
      const huge = JSON.stringify({ blob: 'x'.repeat(6 * 1024 * 1024) });
      await withFetch(
        (async () => new Response(huge, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
        async (client) => {
          await expect(client.getByModelId('acme/model')).rejects.toBeInstanceOf(VllmRecipeUpstreamError);
        }
      );
    });

    test('caches a model recipe so a second call does not refetch', async () => {
      let calls = 0;
      await withFetch(
        (async () => {
          calls += 1;
          return new Response(JSON.stringify({ recipe: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }) as unknown as typeof fetch,
        async (client) => {
          await client.getByModelId('acme/model');
          await client.getByModelId('acme/model');
          expect(calls).toBe(1);
        }
      );
    });
  });
});
