# YouTube Transcript API

This is a simple Vercel Edge Function that fetches transcripts from YouTube videos.

## Usage

Send a GET request to the API endpoint with either a YouTube URL or a video ID:

### Using a YouTube URL:

```
GET /api/transcript?url=YOUTUBE_VIDEO_URL
```

### Using a Video ID directly:

```
GET /api/transcript?id=VIDEO_ID
```

### Text Format Option

By default, the API returns JSON. To get the transcript as plain text:

```
GET /api/transcript?url=YOUTUBE_VIDEO_URL&format=text
```

or

```
GET /api/transcript?id=VIDEO_ID&format=text
```

## Supported URL Formats

The API supports various YouTube URL formats:

- Standard YouTube URLs: `https://www.youtube.com/watch?v=VIDEO_ID`
- Short youtu.be URLs: `https://youtu.be/VIDEO_ID`
- youtu.be URLs with query parameters: `https://youtu.be/VIDEO_ID?feature=shared`
- YouTube /v/ format: `https://youtube.com/v/VIDEO_ID`
- Malformed shared URLs: `https://www.youtube.com/watch?v=VIDEO_ID?feature=shared`
- Direct video IDs: Just the 11-character YouTube video ID

## Example Requests

Using a full URL:
```
GET /api/transcript?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

Using just the video ID:
```
GET /api/transcript?id=dQw4w9WgXcQ
```

Getting plain text format:
```
GET /api/transcript?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&format=text
```

## Example Responses

### JSON Format (default)

```json
{
  "transcript": [
    {
      "text": "We're no strangers to love",
      "duration": 4800,
      "offset": 0
    },
    {
      "text": "You know the rules and so do I",
      "duration": 4800,
      "offset": 4800
    },
    // ... more transcript segments
  ]
}
```

### Text Format

```
We're no strangers to love You know the rules and so do I I full commitments while I'm thinking of you wouldn't get this from any other guy I just want to tell you how I'm feeling got to make you understand Never Going To Give You Up never going to let you down never going to run around and desert you...
```

## Error Handling

The API returns appropriate error messages and status codes:

- 400 Bad Request: If the URL or video ID is missing or invalid
- 405 Method Not Allowed: If a method other than GET is used
- 500 Internal Server Error: If there's a problem fetching the transcript

## Development

1. Clone the repository
2. Install dependencies: `npm install`
3. Install the Vercel CLI: `npm i -g vercel`
4. Start the development server: `npm run dev` (or `vercel dev`)

## Deployment

Deploy to Vercel:

```
npm run deploy
```

Or directly with the Vercel CLI:

```
vercel
``` 