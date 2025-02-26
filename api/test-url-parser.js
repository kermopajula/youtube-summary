// Test cases with inline implementation of the parsing function
// to avoid ESM/CommonJS compatibility issues

function getYoutubeVideoId(url) {
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

// Test cases
const testUrls = [
  {
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    expectedId: 'dQw4w9WgXcQ',
    description: 'Standard youtube.com URL'
  },
  {
    url: 'https://youtu.be/Og3D7QPCtD0',
    expectedId: 'Og3D7QPCtD0',
    description: 'Standard youtu.be URL'
  },
  {
    url: 'https://youtu.be/Og3D7QPCtD0?feature=shared',
    expectedId: 'Og3D7QPCtD0',
    description: 'youtu.be URL with feature parameter'
  },
  {
    url: 'https://youtube.com/v/dQw4w9WgXcQ',
    expectedId: 'dQw4w9WgXcQ',
    description: 'Short youtube.com/v/ URL'
  },
  {
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ?feature=shared',
    expectedId: 'dQw4w9WgXcQ',
    description: 'YouTube URL with double question marks'
  }
];

// Run the tests
console.log('URL Parser Test:');
testUrls.forEach(test => {
  const actualId = getYoutubeVideoId(test.url);
  const passed = actualId === test.expectedId;
  console.log(`${passed ? '✅' : '❌'} ${test.description}: ${test.url} => ${actualId} (expected: ${test.expectedId})`);
}); 