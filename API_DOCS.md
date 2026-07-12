# Drive Movie Indexer - API Docs

This repository contains:

- `server.js` + `driveStream.js`: Google Drive streaming proxy with disk cache (Range support)
- `scanDriveMovies.js`: Drive indexer + TMDB enrichment into MongoDB
- `apiServer.js`: Read-only REST API to expose indexed MongoDB content

## Run the API server

### Requirements

- Node.js (ESM enabled)
- MongoDB connection string in `MONGO_URI`

### Environment variables

- `MONGO_URI` (**required**)
  - Example: `mongodb://127.0.0.1:27017/drive_movies`
- `API_PORT` (optional, default `3001`)

### Start

```bash
npm run api
```

API will listen on `http://localhost:3001` by default.

## Collections used

The API reads these MongoDB collections (created/filled by `scanDriveMovies.js`):

- `movies`
- `series`
- `episodes`

## Conventions

### Pagination

List endpoints support:

- `page` (default `1`)
- `limit` (default `50`, max `200`)

Response format:

```json
{
  "page": 1,
  "limit": 50,
  "total": 1234,
  "items": []
}
```

### Resolve driveFileId

#### `GET /api/resolve/:driveFileId`

Helps identify whether a `driveFileId` exists in the indexed collections.

Behavior:

- checks `movies.driveFileId`
- checks `episodes.driveFileId`
- checks `series.driveFileId` (if present in your data)

Example:

```http
GET /api/resolve/1Zugs6CaleO_8CnXf6f9_N1tNpeZOrxkP
```

Sample responses:

Movie:

```json
{
  "type": "movie",
  "item": {
    "_id": "...",
    "driveFileId": "1Zugs6CaleO_8CnXf6f9_N1tNpeZOrxkP",
    "title": "Some Movie",
    "year": 2016
  }
}
```

Episode:

```json
{
  "type": "episode",
  "item": {
    "_id": "...",
    "driveFileId": "1Zugs6CaleO_8CnXf6f9_N1tNpeZOrxkP",
    "seriesId": "...",
    "season": 1,
    "episode": 2,
    "episodeTitle": "Episode title"
  }
}
```

Not found:

```json
{ "error": "not_found" }
```

### Sorting

Supported `sort` values on list endpoints:

- `title_asc` (default)
- `title_desc`
- `year_asc`
- `year_desc`
- `latest` (sort by `createdAt` desc)

## Endpoints

### Health

#### `GET /health`

Response:

```json
{ "ok": true }
```

#### `GET /api/health`

Same as `/health`.

Response:

```json
{ "ok": true }
```

### API Docs (JSON)

#### `GET /api/docs`

Returns a JSON document describing all available endpoints, query parameters, and required environment variables.

Example:

```http
GET /api/docs
```

Sample response (truncated):

```json
{
  "service": "drive-movie-indexer-api",
  "version": 1,
  "endpoints": {
    "movies_list": { "method": "GET", "path": "/api/movies" },
    "play_redirect": { "method": "GET", "path": "/api/play/:driveFileId" }
  }
}
```

### Genres

#### `GET /api/genres`

Returns distinct genres across `movies` and `series` with counts.

Example:

```http
GET /api/genres
```

Example response:

```json
{
  "total": 3,
  "items": [
    { "genre": "Documentary", "count": 120 },
    { "genre": "Action", "count": 88 },
    { "genre": "Comedy", "count": 40 }
  ]
}
```

### Movies

#### `GET /api/movies`

Query params:

- `page`
- `limit`
- `q` (case-insensitive title search)
- `year`
- `genre` (kategori/genre, matches values inside `genres[]`, case-insensitive)
- `resolution` (e.g. `720p`, `1080p`, `2160p`)
- `sort`

Examples:

```http
GET /api/movies?page=1&limit=50
GET /api/movies?q=batman&sort=year_desc
GET /api/movies?year=2016
GET /api/movies?year=2016&q=legend&genre=documentary
GET /api/movies?genre=action&resolution=1080p
```

Sample response:

```json
{
  "page": 1,
  "limit": 50,
  "total": 2,
  "items": [
    {
      "_id": "...",
      "title": "True Legends – Episode 2 The UnHoly See",
      "year": 2016,
      "genres": ["Documentary"],
      "files": [
        {
          "driveFileId": "14qjHjLEM33gIQe0tCcFNxsMwlD2OPvj8",
          "resolution": "1080p"
        }
      ],
      "createdAt": "2026-03-06T01:00:00.000Z"
    }
  ]
}
```

#### `GET /api/movies/:id`

Fetches a movie document by MongoDB `_id`.

Backward compatible: if `:id` is not a 24-hex ObjectId string, the API will try to resolve it as a legacy `driveFileId` (or `files.driveFileId`).

Example:

```http
GET /api/movies/69a9a86794129e94666737dc
```

Sample response:

```json
{
  "_id": "...",
  "title": "True Legends – Episode 2 The UnHoly See",
  "year": 2016,
  "files": [
    {
      "driveFileId": "14qjHjLEM33gIQe0tCcFNxsMwlD2OPvj8",
      "fileName": "True Legends – Episode 2 The UnHoly See (2016) - 1080p.mkv",
      "driveLink": "https://drive.google.com/file/d/14qjHjLEM33gIQe0tCcFNxsMwlD2OPvj8/view",
      "fileSize": 2329178880,
      "resolution": "1080p"
    }
  ],
  "genres": ["Documentary"],
  "playCount": 12,
  "lastPlayedAt": "2026-03-06T03:00:00.000Z",
  "createdAt": "2026-03-06T01:00:00.000Z"
}
```

Not found:

```json
{ "error": "not_found" }
```

### Series

#### `GET /api/series`

Query params:

- `page`
- `limit`
- `q` (case-insensitive title search)
- `year`
- `genre` (kategori/genre, matches values inside `genres[]`, case-insensitive)
- `sort`

Examples:

```http
GET /api/series?page=1&limit=50
GET /api/series?q=true%20legends
GET /api/series?year=2016&q=true&genre=documentary
```

Sample response:

```json
{
  "page": 1,
  "limit": 50,
  "total": 1,
  "items": [
    {
      "_id": "...",
      "title": "True Legends",
      "year": 2016,
      "genres": ["Documentary"],
      "createdAt": "2026-03-06T01:00:00.000Z"
    }
  ]
}
```

#### `GET /api/series/:id`

Fetches a series document by `_id`.

Note: if your `series._id` is an `ObjectId`, this endpoint may require an update to convert the string param into `ObjectId`.

Sample response:

```json
{
  "_id": "...",
  "title": "True Legends",
  "year": 2016,
  "genres": ["Documentary"],
  "overview": "...",
  "createdAt": "2026-03-06T01:00:00.000Z"
}
```

Not found:

```json
{ "error": "not_found" }
```

### Episodes

#### `GET /api/episodes`

Query params:

- `page`
- `limit`
- `seriesId`
- `season`
- `episode`
- `resolution` (e.g. `720p`, `1080p`, `2160p`)

Examples:

```http
GET /api/episodes?seriesId=<seriesId>
GET /api/episodes?seriesId=<seriesId>&season=1
GET /api/episodes?seriesId=<seriesId>&season=1&episode=2
```

Sample response:

```json
{
  "page": 1,
  "limit": 50,
  "total": 1,
  "items": [
    {
      "_id": "...",
      "driveFileId": "14qjHjLEM33gIQe0tCcFNxsMwlD2OPvj8",
      "seriesId": "...",
      "season": 1,
      "episode": 2,
      "episodeTitle": "The UnHoly See",
      "resolution": "1080p",
      "createdAt": "2026-03-06T01:00:00.000Z"
    }
  ]
}
```

#### `GET /api/episodes/:driveFileId`

Looks up an episode document by `driveFileId`.

Sample response:

```json
{
  "_id": "...",
  "driveFileId": "14qjHjLEM33gIQe0tCcFNxsMwlD2OPvj8",
  "seriesId": "...",
  "season": 1,
  "episode": 2,
  "episodeTitle": "The UnHoly See",
  "fileName": "...",
  "driveLink": "...",
  "fileSize": 2329178880,
  "resolution": "1080p",
  "playCount": 12,
  "lastPlayedAt": "2026-03-06T03:00:00.000Z",
  "createdAt": "2026-03-06T01:00:00.000Z"
}
```

Not found:

```json
{ "error": "not_found" }
```

## Play tracking + redirect

You can track plays using a dedicated endpoint that increments counters in MongoDB and then redirects the client to an external player server.

### Environment variables

- `PLAYER_BASE_URL` (**required** for this endpoint)
  - Example: `https://gdriveapps.lovelywombat.box.ca`
- `PLAYER_PATH_TEMPLATE` (optional)
  - Default: `/stream/{fileId}`
  - `{fileId}` will be replaced with the requested Drive file id.

### Endpoint

#### `GET /api/play/:driveFileId`

Legacy endpoint (file-based).

Behavior:

- logs plays into MongoDB collection `plays` (upsert by `driveFileId`)
  - increments `playCount`
  - sets `lastPlayedAt` to now
- best-effort: if the file exists in `movies` or `episodes`, it also updates those documents
- responds with `307` redirect to `PLAYER_BASE_URL + PLAYER_PATH_TEMPLATE`

This endpoint redirects even if the file is not yet indexed in `movies/episodes`.

Response:

- HTTP status: `307`
- Header: `Location: <PLAYER_BASE_URL + PLAYER_PATH_TEMPLATE>`

Example (headers):

```http
HTTP/1.1 307 Temporary Redirect
Location: https://gdriveapps.lovelywombat.box.ca/stream/14qjHjLEM33gIQe0tCcFNxsMwlD2OPvj8
```

Example:

```http
GET /api/play/14qjHjLEM33gIQe0tCcFNxsMwlD2OPvj8
```

#### `GET /api/play/movie/:movieId`

Movie-based endpoint.

Behavior:

- selects a file id from `movies.files[]` (optionally preferring a specific `resolution`)
- increments `movies.playCount` and sets `movies.lastPlayedAt`
- logs play events into MongoDB collection `plays` (upsert by `movieId`)
- responds with `307` redirect to `PLAYER_BASE_URL + PLAYER_PATH_TEMPLATE` using the chosen file id

Query params:

- `resolution` (optional, prefer this file resolution if available, e.g. `720p`, `1080p`, `2160p`)

Example:

```http
GET /api/play/movie/69a9a86794129e94666737dc?resolution=1080p
```

## Notes / Next improvements

- Search currently uses regex on `title`. For large libraries, consider adding a MongoDB text index and switching to `$text` queries.
- Consider adding projection fields (to reduce payload size).
- Consider adding authentication if the API is exposed publicly.
