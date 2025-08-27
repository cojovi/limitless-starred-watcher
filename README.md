# Limitless Starred Watcher

A Node.js application that monitors starred Lifelogs from the Limitless API, stores them in SQLite, performs sentiment analysis using OpenAI, and posts webhooks for new/updated entries.

## Features

- **Starred-only monitoring**: Only tracks starred Lifelogs from Limitless
- **SQLite storage**: Local database with full entry history and sentiment analysis
- **OpenAI integration**: Automatic sentiment analysis for each entry
- **Webhook notifications**: Posts to webhook URL for each new/updated starred entry
- **Rate limiting**: Handles API rate limits with exponential backoff
- **Cursor pagination**: Efficient pagination through large datasets
- **Duplicate prevention**: Prevents double-firing webhooks

## Quick Start

1. **Clone the repository**:
   ```bash
   git clone https://github.com/yourusername/limitless-starred-routing.git
   cd limitless-starred-routing
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment variables**:
   Copy `.env.example` to `.env` and update with your API keys:
   ```bash
   cp .env.example .env
   # Edit .env with your actual API keys
   ```

4. **Test setup**:
   ```bash
   npm test
   ```

5. **Run the application**:
   ```bash
   npm run once    # One-time import
   npm start       # Continuous monitoring
   ```

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment variables**:
   Edit `.env` file with your API keys:
   ```ini
   LIMITLESS_API_KEY=your_limitless_api_key_here
   OPENAI_API_KEY=your_openai_api_key_here
   WEBHOOK_URL=your_webhook_url_here
   ```

3. **Optional configuration**:
   - `DB_PATH`: SQLite database path (default: `./starred.db`)
   - `TIMEZONE`: Timezone for API requests (default: `America/Chicago`)
   - `POLL_SECONDS`: Polling interval in seconds (default: `120`)
   - `MAX_PAGES_PER_RUN`: Max pages per scan (default: `25`)
   - `OPENAI_MODEL`: OpenAI model for sentiment analysis (default: `gpt-4o-mini`)
   - `BACKFILL_SEND_WEBHOOK`: Send webhooks during initial backfill (default: `0`)

## Usage

### One-shot scan
Run once, ingest all starred entries, then exit:
```bash
npm run once
```

### Daemon mode
Continuous monitoring with polling:
```bash
npm start
```

### Backfill with webhooks
Initial backfill that also sends webhooks (off by default):
```bash
npm run backfill
```

### Test setup
Verify your environment is configured correctly:
```bash
npm test
```

## Database Schema

The SQLite database contains:

- **lifelogs table**: Stores all starred Lifelog entries with metadata
- **kv table**: Key-value store for application state

### Key fields:
- `id`: Unique Lifelog identifier
- `title`, `markdown`: Entry content
- `startTime`, `endTime`: Entry timestamps
- `isStarred`: Star status
- `analysis_json`: OpenAI sentiment analysis results
- `webhook_last_updatedAt`: Last webhook sent timestamp
- `webhook_status`: HTTP status of last webhook

## Webhook Payload

Each webhook POST contains:
```json
{
  "source": "limitless-starred",
  "lifelogId": "entry_id",
  "title": "Entry title",
  "startTime": "2024-01-01T00:00:00Z",
  "endTime": "2024-01-01T01:00:00Z",
  "updatedAt": "2024-01-01T00:00:00Z",
  "isStarred": true,
  "analysis": {
    "sentiment": "positive",
    "confidence": 0.85,
    "emotional_valence": 0.7,
    "urgency": 1,
    "summary": "Brief summary of the entry"
  },
  "markdownPreview": "First 4000 characters of markdown content"
}
```

## Database Queries

### View recent entries:
```sql
SELECT id, substr(title,1,60), isStarred, date(inserted_at), length(markdown) 
FROM lifelogs 
ORDER BY inserted_at DESC 
LIMIT 10;
```

### View sentiment analysis:
```sql
SELECT id, 
       json_extract(analysis_json,"$.sentiment"), 
       json_extract(analysis_json,"$.confidence") 
FROM lifelogs 
WHERE analysis_json IS NOT NULL 
ORDER BY last_seen_at DESC 
LIMIT 10;
```

## Rate Limits

- **Limitless API**: 180 requests per minute
- **OpenAI API**: Varies by model and plan
- **Webhook**: No built-in rate limiting (configure on webhook endpoint)

## Error Handling

- Automatic retry with exponential backoff for API failures
- Graceful handling of missing OpenAI API key
- Database transaction safety with WAL mode
- Comprehensive error logging

## Requirements

- Node.js 18+ (uses global fetch)
- SQLite3 support
- Internet connection for API access

## Windows Compatibility

This project is fully compatible with Windows and includes:
- Cross-platform environment variable handling with `cross-env`
- Windows-compatible npm scripts
- SQLite database works on all platforms

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

If you encounter any issues or have questions, please [open an issue](https://github.com/yourusername/limitless-starred-routing/issues) on GitHub.
