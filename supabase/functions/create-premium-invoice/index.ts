import { corsHeaders, jsonResponse } from '../_shared/telegram.ts';

Deno.serve(request => {
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  return jsonResponse({
    error: 'Real payments are disabled during the closed Telegram test',
    payment_mode: 'disabled'
  }, 403, cors);
});
