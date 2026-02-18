export const config = {
  runtime: 'edge',
};

const RE_XML_TRANSCRIPT = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
const RE_XML_TRANSCRIPT_ASR = /<p t="(\d+)" d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
const RE_XML_TRANSCRIPT_ASR_SEGMENT = /<s[^>]*>([^<]*)<\/s>/g;

const CONSENT_COOKIE = 'SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgLC_pwY';

/**
 * Fetch transcript XML from a caption track URL and parse it.
 */
async function fetchTranscriptFromTrackUrl(trackUrl, lang) {
  const response = await fetch(trackUrl);

  if (!response.ok) {
    throw new Error(`Transcript XML fetch failed: ${response.status}`);
  }

  const body = await response.text();

  if (!body.length) {
    throw new Error('Transcript response is empty');
  }

  const transcript = parseTranscriptXml(body, lang || 'en');

  if (!transcript.length) {
    throw new Error('Parsed transcript is empty');
  }

  return transcript;
}

/**
 * Extract caption track info from an InnerTube player API response.
 */
function extractTrackFromPlayerResponse(data) {
  const captions = data?.captions?.playerCaptionsTracklistRenderer;
  if (!captions?.captionTracks?.length) {
    throw new Error('No caption tracks in player response');
  }

  const track = captions.captionTracks.find((t) => t.kind === 'asr') || captions.captionTracks[0];
  return { url: track.baseUrl, lang: track.languageCode };
}

/**
 * Server-side: fetch captions directly from YouTube.
 * Works from residential IPs but fails from datacenter IPs.
 */
async function fetchTranscriptServerSide(videoId) {
  // Try InnerTube ANDROID client
  const response = await fetch('https://www.youtube.com/youtubei/v1/player', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'com.google.android.youtube/19.29.37 (Linux; Android 13)',
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: '19.29.37',
          androidSdkVersion: 33,
          hl: 'en',
          gl: 'US',
        },
      },
      videoId,
    }),
  });

  const data = await response.json();
  const track = extractTrackFromPlayerResponse(data);
  return await fetchTranscriptFromTrackUrl(track.url, track.lang);
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

  /**
   * POST mode: client sends YouTube InnerTube player API response.
   *
   * The client (e.g. Apple Shortcuts) should:
   * 1. POST to https://www.youtube.com/youtubei/v1/player with:
   *    {"context":{"client":{"clientName":"ANDROID","clientVersion":"19.29.37","androidSdkVersion":33,"hl":"en","gl":"US"}},"videoId":"VIDEO_ID"}
   * 2. Forward that response body here as a POST.
   *
   * This works because the client has a residential IP that YouTube trusts,
   * and the timedtext URLs in the response are signed but not IP-bound.
   */
  if (req.method === 'POST') {
    try {
      const body = await req.text();
      if (!body) {
        return jsonResponse({ error: 'POST body required' }, 400);
      }

      const parsed = JSON.parse(body);
      // Support both direct response and wrapped (e.g. {"player_response": ...} from Apple Shortcuts)
      const data = parsed.player_response || parsed;
      const track = extractTrackFromPlayerResponse(data);
      const transcript = await fetchTranscriptFromTrackUrl(track.url, track.lang);
      return transcriptResponse(transcript, format);
    } catch (error) {
      return jsonResponse({ error: 'Failed to fetch transcript', details: error.message }, 500);
    }
  }

  // GET mode: server fetches directly (may fail from datacenter IPs)
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
        hint: 'YouTube blocks server IPs. Use POST mode: have your client call the YouTube InnerTube API and forward the response here.',
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
