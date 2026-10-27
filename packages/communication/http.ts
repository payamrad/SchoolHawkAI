import { CommunicationError } from "./index";

const MAX_RESPONSE_BYTES = 65536;

export async function readProviderResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new CommunicationError("INVALID_RECEIPT");
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) throw new CommunicationError("INVALID_RECEIPT");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new CommunicationError("INVALID_RECEIPT");
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new CommunicationError("INVALID_RECEIPT"); }
}
