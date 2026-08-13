// Cloudflare Pages Function — 签发 Gemini Live API ephemeral token
// GEMINI_API_KEY 从 Cloudflare 环境变量/Secret 读取，绝不进入代码与仓库。
export async function onRequestPost(context) {
  const apiKey = context.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response('GEMINI_API_KEY is not configured on the server.', { status: 500 });
  }

  const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(Date.now() + 60 * 1000).toISOString();

  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        uses: 1,
        expireTime,
        newSessionExpireTime
      })
    });

    const body = await response.text();
    if (!response.ok) {
      return new Response(`Gemini ${response.status}: ${body}`, { status: response.status });
    }

    const data = JSON.parse(body);
    if (!data.name) {
      return new Response('Gemini did not return an ephemeral token.', { status: 500 });
    }

    return new Response(
      JSON.stringify({
        token: data.name,
        expireTime: data.expireTime || expireTime
      }),
      {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      }
    );
  } catch (error) {
    return new Response(`Failed to create Gemini ephemeral token: ${error.message}`, { status: 500 });
  }
}
