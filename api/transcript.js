const RE_XML_TRANSCRIPT = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
const RE_XML_TRANSCRIPT_ASR = /<p t="(\d+)" d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
const RE_XML_TRANSCRIPT_ASR_SEGMENT = /<s[^>]*>([^<]*)<\/s>/g;

const CONSENT_COOKIE = 'SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgLC_pwY';

async function fetchTranscript(videoId) {
  const errors = [];

  // Step 1: Use youtubei.js (handles session generation and multiple API paths)
  try {
    const result = await fetchViaYoutubei(videoId);
    if (result.length) return result;
  } catch (err) {
    errors.push(`youtubei.js: ${err.message}`);
  }

  // Step 2: Fetch the watch page for embedded captions
  let pageData = null;
  try {
    pageData = await fetchWatchPage(videoId);
  } catch (err) {
    errors.push(`Page fetch: ${err.message}`);
  }

  if (pageData?.captions) {
    try {
      const result = await fetchTranscriptFromCaptions(pageData.captions);
      if (result.length) return result;
    } catch (err) {
      errors.push(`Page captions: ${err.message}`);
    }
  }

  // Step 3: Try InnerTube WEB client with visitor data
  try {
    const result = await fetchViaInnerTubeClient(videoId, {
      clientName: 'WEB',
      clientVersion: '2.20241126.01.00',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      visitorData: pageData?.visitorData,
    });
    if (result.length) return result;
  } catch (err) {
    errors.push(`InnerTube WEB: ${err.message}`);
  }

  // Step 4: Try InnerTube ANDROID client
  try {
    const result = await fetchViaInnerTubeClient(videoId, {
      clientName: 'ANDROID',
      clientVersion: '19.29.37',
      userAgent: 'com.google.android.youtube/19.29.37 (Linux; Android 13)',
      androidSdkVersion: 33,
    });
    if (result.length) return result;
  } catch (err) {
    errors.push(`InnerTube ANDROID: ${err.message}`);
  }

  throw new Error(`All methods failed for ${videoId}: ${errors.join('; ')}`);
}

async function fetchViaYoutubei(videoId) {
  const { Innertube } = await import('youtubei.js');
  const yt = await Innertube.create({ generate_session_locally: true });
  const info = await yt.getBasicInfo(videoId);

  const tracks = info.captions?.caption_tracks;
  if (!tracks?.length) {
    throw new Error('No caption tracks in player response');
  }

  const track = tracks.find((t) => t.kind === 'asr') || tracks[0];
  const response = await fetch(track.base_url);

  if (!response.ok) {
    throw new Error(`Transcript XML fetch failed: ${response.status}`);
  }

  const body = await response.text();
  const transcript = parseTranscriptXml(body, track.language_code);

  if (!transcript.length) {
    throw new Error('Parsed transcript is empty');
  }

  return transcript;
}

async function fetchWatchPage(videoId) {
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}&bpctr=9999999999`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': CONSENT_COOKIE,
    },
  });

  const html = await response.text();

  if (html.includes('class="g-recaptcha"')) {
    throw new Error('Rate limited by YouTube (CAPTCHA required)');
  }

  let visitorData = null;
  const visitorMatch = html.match(/"visitorData"\s*:\s*"([^"]+)"/);
  if (visitorMatch) {
    visitorData = visitorMatch[1];
  }

  let captions = null;
  const captionsParts = html.split('"captions":');
  if (captionsParts.length > 1) {
    try {
      const captionsJson = captionsParts[1].split(',"videoDetails')[0].replace('\n', '');
      captions = JSON.parse(captionsJson)?.playerCaptionsTracklistRenderer;
      if (!captions?.captionTracks?.length) {
        captions = null;
      }
    } catch {
      // Failed to parse
    }
  }

  return { visitorData, captions };
}

async function fetchViaInnerTubeClient(videoId, clientConfig) {
  const context = {
    client: {
      clientName: clientConfig.clientName,
      clientVersion: clientConfig.clientVersion,
      hl: 'en',
      gl: 'US',
    },
  };

  if (clientConfig.androidSdkVersion) {
    context.client.androidSdkVersion = clientConfig.androidSdkVersion;
  }

  if (clientConfig.visitorData) {
    context.client.visitorData = clientConfig.visitorData;
  }

  const response = await fetch('https://www.youtube.com/youtubei/v1/player', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': clientConfig.userAgent,
    },
    body: JSON.stringify({ context, videoId }),
  });

  const data = await response.json();
  const captions = data?.captions?.playerCaptionsTracklistRenderer;

  if (!captions || !captions.captionTracks?.length) {
    throw new Error('No captions in response');
  }

  return await fetchTranscriptFromCaptions(captions);
}

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

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const videoUrl = req.query.url;
  const videoId = req.query.id;
  const format = req.query.format || 'json';

  let targetVideoId = null;

  if (videoUrl) {
    targetVideoId = getYoutubeVideoId(videoUrl);
  } else if (videoId) {
    targetVideoId = videoId;
  }

  if (!targetVideoId) {
    return res.status(400).json({ error: 'Valid YouTube URL or video ID is required' });
  }

  try {
    const transcript = await fetchTranscript(targetVideoId);

    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=600');

    if (format.toLowerCase() === 'text') {
      const textTranscript = transcript.map((s) => s.text).join(' ');
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send(textTranscript);
    } else {
      return res.status(200).json({ transcript });
    }
  } catch (error) {
    console.error('Error fetching transcript:', error);
    return res.status(500).json({
      error: 'Failed to fetch transcript',
      details: error.message,
    });
  }
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
