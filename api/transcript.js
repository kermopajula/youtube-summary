export const config = {
  runtime: 'edge',
};

const RE_XML_TRANSCRIPT = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
const RE_XML_TRANSCRIPT_ASR = /<p t="(\d+)" d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
const RE_XML_TRANSCRIPT_ASR_SEGMENT = /<s[^>]*>([^<]*)<\/s>/g;

const CONSENT_COOKIE = 'SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgLC_pwY';

/**
 * Extract captions object from YouTube watch page HTML.
 */
function extractCaptionsFromHtml(html) {
  const parts = html.split('"captions":');
  if (parts.length <= 1) {
    if (html.includes('class="g-recaptcha"')) {
      throw new Error('Rate limited by YouTube (CAPTCHA required)');
    }
    return null;
  }

  try {
    const captionsJson = parts[1].split(',"videoDetails')[0].replace('\n', '');
    const captions = JSON.parse(captionsJson)?.playerCaptionsTracklistRenderer;
    if (!captions?.captionTracks?.length) return null;
    return captions;
  } catch {
    return null;
  }
}

/**
 * Fetch transcript XML from a caption track URL and parse it.
 */
async function fetchTranscriptFromCaptions(captions) {
  const track = captions.captionTracks.find((t) => t.kind === 'asr') || captions.captionTracks[0];
  const response = await fetch(track.baseUrl);

  if (!response.ok) {
    throw new Error(`Transcript XML fetch failed: ${response.status}`);
  }

  const body = await response.text();
  const transcript = parseTranscriptXml(body, track.languageCode);

  if (!transcript.length) {
    throw new Error('Parsed transcript is empty');
  }

  return transcript;
}

/**
 * Server-side fetch: try to get captions directly from YouTube.
 * This works from residential IPs but may fail from datacenter IPs.
 */
async function fetchTranscriptServerSide(videoId) {
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}&bpctr=9999999999`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': CONSENT_COOKIE,
    },
  });

  const html = await response.text();
  const captions = extractCaptionsFromHtml(html);

  if (!captions) {
    throw new Error('No captions in page (YouTube may be blocking this server IP)');
  }

  return await fetchTranscriptFromCaptions(captions);
}

/**
 * Client-assisted fetch: parse captions from HTML provided by the client.
 * The client fetches the YouTube page from their residential IP and POSTs
 * the HTML here. The timedtext URLs are signed and work from any IP.
 */
async function fetchTranscriptFromClientHtml(html) {
  const captions = extractCaptionsFromHtml(html);

  if (!captions) {
    throw new Error('No captions found in provided HTML');
  }

  return await fetchTranscriptFromCaptions(captions);
}

function parseTranscriptXml(body, lang) {
  const results = [...body.matchAll(RE_XML_TRANSCRIPT)];
  if (results.length) {
    return results
      .map((result) => ({
        text: decodeHTMLEntities(result[3]),
        duration: parseFloat(result[2]),
        offset: parseFloat(result[1]),
        lang,
      }))
      .filter((item) => item.text.trim() !== '');
  }

  const asrResults = [...body.matchAll(RE_XML_TRANSCRIPT_ASR)];
  return asrResults
    .map((block) => {
      const segments = [...block[3].matchAll(RE_XML_TRANSCRIPT_ASR_SEGMENT)];
      let text;
      if (segments.length) {
        text = segments.map((s) => s[1]).join('').trim();
      } else {
        text = block[3].replace(/<[^>]*>/g, '').trim();
      }
      if (!text) return null;
      return {
        text: decodeHTMLEntities(text),
        duration: Number(block[2]) / 1000,
        offset: Number(block[1]) / 1000,
        lang,
      };
    })
    .filter(Boolean);
}

function decodeHTMLEntities(text) {
  if (!text) return '';
  return text
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

export default async function handler(req) {
  const url = new URL(req.url);
  const format = url.searchParams.get('format') || 'json';

  // POST: client sends YouTube page HTML for parsing
  if (req.method === 'POST') {
    try {
      const html = await req.text();

      if (!html || html.length < 1000) {
        return jsonResponse({ error: 'POST body must contain YouTube page HTML' }, 400);
      }

      const transcript = await fetchTranscriptFromClientHtml(html);
      return transcriptResponse(transcript, format);
    } catch (error) {
      return jsonResponse({ error: 'Failed to fetch transcript', details: error.message }, 500);
    }
  }

  // GET: server fetches directly from YouTube (may fail from datacenter IPs)
  if (req.method === 'GET') {
    const videoUrl = url.searchParams.get('url');
    const videoId = url.searchParams.get('id');

    let targetVideoId = null;
    if (videoUrl) {
      targetVideoId = getYoutubeVideoId(videoUrl);
    } else if (videoId) {
      targetVideoId = videoId;
    }

    if (!targetVideoId) {
      return jsonResponse({ error: 'Valid YouTube URL or video ID is required' }, 400);
    }

    try {
      const transcript = await fetchTranscriptServerSide(targetVideoId);
      return transcriptResponse(transcript, format);
    } catch (error) {
      return jsonResponse({
        error: 'Failed to fetch transcript',
        details: error.message,
        hint: 'YouTube blocks server IPs. Use POST with the YouTube page HTML instead. Have your client fetch https://www.youtube.com/watch?v=VIDEO_ID and POST the HTML body here.',
      }, 500);
    }
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function transcriptResponse(transcript, format) {
  const headers = {
    'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
  };

  if (format.toLowerCase() === 'text') {
    return new Response(transcript.map((s) => s.text).join(' '), {
      status: 200,
      headers: { ...headers, 'Content-Type': 'text/plain' },
    });
  }

  return new Response(JSON.stringify({ transcript }), {
    status: 200,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

export function getYoutubeVideoId(url) {
  if (/^[a-zA-Z0-9_-]{11,12}$/.test(url)) {
    return url;
  }

  try {
    if (url.includes('youtube.com/watch?') && url.indexOf('?') !== url.lastIndexOf('?')) {
      const firstQuestionMarkIndex = url.indexOf('?');
      const paramString = url.substring(firstQuestionMarkIndex + 1);
      const params = paramString.split('?')[0].split('&');

      for (const param of params) {
        const [key, value] = param.split('=');
        if (key === 'v' && value) {
          return value;
        }
      }
    }

    const urlObj = new URL(url);

    if (urlObj.hostname.includes('youtube.com')) {
      if (urlObj.pathname === '/watch') {
        return urlObj.searchParams.get('v');
      }

      if (urlObj.pathname.startsWith('/v/')) {
        return urlObj.pathname.split('/')[2];
      }
    }

    if (urlObj.hostname === 'youtu.be') {
      const pathParts = urlObj.pathname.split('/');
      return pathParts[1] ? pathParts[1] : null;
    }

    return null;
  } catch (error) {
    try {
      if (url.includes('youtube.com/watch?v=')) {
        const vIndex = url.indexOf('watch?v=');
        let videoId = url.substring(vIndex + 8);
        const endIndex = Math.min(
          videoId.indexOf('?') > -1 ? videoId.indexOf('?') : Infinity,
          videoId.indexOf('&') > -1 ? videoId.indexOf('&') : Infinity
        );

        if (endIndex !== Infinity) {
          videoId = videoId.substring(0, endIndex);
        }

        return videoId || null;
      }
    } catch (e) {
      return null;
    }
    return null;
  }
}
