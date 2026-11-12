// Byte-level download progress for model files fetched from Hugging Face.
// Shared by the page (Voz) and the speaker worker (Who).

/**
 * Voz reports download progress per file (6 files, one of them ~350 MB), so its
 * bar sits still for minutes. Count bytes instead: while the model loads, wrap
 * fetch and tally every Hugging Face response as it streams in.
 */
export function trackModelBytes(onBytes: (loaded: number, total: number) => void): () => void {
  const original = globalThis.fetch;
  let loaded = 0;
  let total = 0;
  const isHub = (u: string) => /huggingface\.co|hf\.co|xethub|cdn-lfs/.test(u);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init);
    const asked = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!res.ok || !res.body || !(isHub(asked) || isHub(res.url))) return res;
    total += Number(res.headers.get("content-length")) || 0;
    const reader = res.body.getReader();
    const counted = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        loaded += value.byteLength;
        onBytes(loaded, Math.max(total, loaded));
        controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return () => {
    globalThis.fetch = original;
  };
}

export const mb = (bytes: number) => Math.round(bytes / 1_000_000).toLocaleString();
