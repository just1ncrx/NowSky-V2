export const config = {
  runtime: 'edge',
};

export default async function handler() {
  const upstreamUrl = 'https://radar.wetterstation-neustadt.de/blitze/live-stream';

  const upstreamResp = await fetch(upstreamUrl);

  if (!upstreamResp.ok || !upstreamResp.body) {
    return new Response('event: error\ndata: {"error":"upstream_unavailable"}\n\n', {
      status: 502,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  // Body 1:1 durchreichen (Edge Runtime unterstützt Streaming direkt)
  return new Response(upstreamResp.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
