export const config = {
  runtime: 'edge'
};

const RE_XML_TRANSCRIPT = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
const RE_XML_TRANSCRIPT_ASR = /<p t="(\d+)" d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
const RE_XML_TRANSCRIPT_ASR_SEGMENT = /<s[^>]*>([^<]*)<\/s>/g;

async function fetchTranscript(videoId) {
  const errors = [];

  // Try InnerTube ANDROID client (most reliable for captions)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await fetchViaInnerTube(videoId);
      if (result.length) return result;
    } catch (err) {
      errors.push(`InnerTube attempt ${attempt + 1}: ${err.message}`);
    }
  }

  // Fall back to HTML scraping (different network path)
  try {
    const result = await fetchViaHtmlScraping(videoId);
    if (result.length) return result;
  } catch (err) {
    errors.push(`HTML scraping: ${err.message}`);
  }

  throw new Error(`All methods failed for ${videoId}: ${errors.join('; ')}`);
}

async function fetchViaInnerTube(videoId) {
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
  const captions = data?.captions?.playerCaptionsTracklistRenderer;

  if (!captions || !captions.captionTracks?.length) {
    throw new Error('No captions in response');
  }

  return await fetchTranscriptFromCaptions(captions);
}

async function fetchViaHtmlScraping(videoId) {
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
  });

  const html = await response.text();
  const parts = html.split('"captions":');

  if (parts.length <= 1) {
    if (html.includes('class="g-recaptcha"')) {
      throw new Error('Rate limited by YouTube (CAPTCHA required)');
    }
    throw new Error('No captions found in page HTML');
  }

  let captions;
  try {
    const captionsJson = parts[1].split(',"videoDetails')[0].replace('\n', '');
    captions = JSON.parse(captionsJson)?.playerCaptionsTracklistRenderer;
  } catch {
    throw new Error('Failed to parse captions from HTML');
  }

  if (!captions || !captions.captionTracks?.length) {
    throw new Error('No caption tracks in parsed HTML');
  }

  return await fetchTranscriptFromCaptions(captions);
}

async function fetchTranscriptFromCaptions(captions) {
  const track = captions.captionTracks.find(t => t.kind === 'asr') || captions.captionTracks[0];
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

function parseTranscriptXml(body, lang) {
  const results = [...body.matchAll(RE_XML_TRANSCRIPT)];
  if (results.length) {
    return results
      .map(result => ({
        text: decodeHTMLEntities(result[3]),
        duration: parseFloat(result[2]),
        offset: parseFloat(result[1]),
        lang,
      }))
      .filter(item => item.text.trim() !== '');
  }

  const asrResults = [...body.matchAll(RE_XML_TRANSCRIPT_ASR)];
  return asrResults
    .map(block => {
      const segments = [...block[3].matchAll(RE_XML_TRANSCRIPT_ASR_SEGMENT)];
      let text;
      if (segments.length) {
        text = segments.map(s => s[1]).join('').trim();
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
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(req.url);
  const videoUrl = url.searchParams.get('url');
  const videoId = url.searchParams.get('id');
  const format = url.searchParams.get('format') || 'json';

  let targetVideoId = null;

  if (videoUrl) {
    targetVideoId = getYoutubeVideoId(videoUrl);
  } else if (videoId) {
    targetVideoId = videoId;
  }

  if (!targetVideoId) {
    return new Response(JSON.stringify({ error: 'Valid YouTube URL or video ID is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const transcript = await fetchTranscript(targetVideoId);

    if (format.toLowerCase() === 'text') {
      const textTranscript = formatTranscriptAsText(transcript);
      return new Response(textTranscript, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
        },
      });
    } else {
      return new Response(JSON.stringify({ transcript }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
        },
      });
    }
  } catch (error) {
    console.error('Error fetching transcript:', error);

    return new Response(
      JSON.stringify({
        error: 'Failed to fetch transcript',
        details: error.message
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

function formatTranscriptAsText(transcript) {
  return transcript
    .map(segment => segment.text)
    .join(' ');
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
