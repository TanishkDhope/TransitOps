import api from './axios.js';
import { baseURL } from './axios.js';

export const askCopilot = (data) => api.post('/api/v1/copilot/ask', data);
export const getCopilotStatus = () => api.get('/api/v1/copilot/status');

/**
 * Streaming variant of askCopilot. Consumes SSE events from the copilot
 * service and calls `onProgress({ step, label })` for each intermediate step.
 * Resolves with the final `{ data }` result payload when complete.
 *
 * Falls back to the non-streaming endpoint if the stream fails to connect.
 */
export async function askCopilotStream({ question, onProgress, signal }) {
  const url = `${baseURL}/api/v1/copilot/ask/stream`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ question }),
    signal,
  });

  if (!response.ok) {
    // Surface something the caller's catch block can work with.
    const text = await response.text().catch(() => '');
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* ignore */ }
    const err = new Error(parsed?.message || `Copilot request failed (${response.status})`);
    err.response = { status: response.status, data: parsed || { message: text } };
    throw err;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE format: each event is "data: {json}\n\n"
    const lines = buffer.split('\n\n');
    // Keep the last incomplete chunk in the buffer.
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;

      const jsonStr = trimmed.slice(6); // strip "data: "
      let event;
      try { event = JSON.parse(jsonStr); } catch { continue; }

      if (event.type === 'progress') {
        onProgress?.(event);
      } else if (event.type === 'result') {
        finalResult = event.data;
      } else if (event.type === 'error') {
        const err = new Error(event.message || 'Copilot stream error');
        err.response = { status: 500, data: { message: event.message } };
        throw err;
      }
    }
  }

  if (!finalResult) {
    throw new Error('Stream ended without a result');
  }

  // Return in the same shape the non-streaming path returns via axios.
  return { data: { success: true, message: 'Copilot responded.', data: finalResult } };
}
