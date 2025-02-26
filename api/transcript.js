import { YoutubeTranscript } from 'youtube-transcript';

export const config = {
  runtime: 'edge'
};

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

  // Check if we have a URL or direct video ID
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
    const transcript = await YoutubeTranscript.fetchTranscript(targetVideoId);
    
    // Format response based on the format parameter
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

// Format transcript array into readable text
function formatTranscriptAsText(transcript) {
  return transcript
    .map(segment => {
      // Clean up HTML entities in the text (like &amp;#39; for apostrophe)
      return segment.text
        .replace(/&amp;#39;/g, "'")
        .replace(/&amp;quot;/g, '"')
        .replace(/&amp;amp;/g, '&')
        .replace(/&amp;lt;/g, '<')
        .replace(/&amp;gt;/g, '>');
    })
    .join(' ');
}

export function getYoutubeVideoId(url) {
  // If the URL is already just a video ID (11-12 characters, alphanumeric with some special chars)
  if (/^[a-zA-Z0-9_-]{11,12}$/.test(url)) {
    return url;
  }

  try {
    // Handle malformed URLs with double question marks (common in shared links)
    if (url.includes('youtube.com/watch?') && url.indexOf('?') !== url.lastIndexOf('?')) {
      // Extract video ID from malformed URL using string operations
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
    
    // Standard URL parsing for well-formed URLs
    const urlObj = new URL(url);
    
    // Handle youtube.com URLs
    if (urlObj.hostname.includes('youtube.com')) {
      if (urlObj.pathname === '/watch') {
        return urlObj.searchParams.get('v');
      }
      
      // Handle shortened youtube.com URLs like youtube.com/v/VIDEO_ID
      if (urlObj.pathname.startsWith('/v/')) {
        return urlObj.pathname.split('/')[2];
      }
    }
    
    // Handle youtu.be URLs
    if (urlObj.hostname === 'youtu.be') {
      // Extract the video ID from the pathname, ignoring any query parameters
      const pathParts = urlObj.pathname.split('/');
      return pathParts[1] ? pathParts[1] : null;
    }
    
    return null;
  } catch (error) {
    // For any parsing errors, attempt manual extraction for common patterns
    try {
      if (url.includes('youtube.com/watch?v=')) {
        const vIndex = url.indexOf('watch?v=');
        let videoId = url.substring(vIndex + 8); // 8 is the length of 'watch?v='
        // Trim the ID at the first ? or & if present
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