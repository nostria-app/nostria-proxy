# nostria-proxy

Azure Functions app providing proxy services for the Nostria application.

## Functions

### ImageOptimizeProxy

Optimizes and resizes images on-the-fly.

**Endpoint:** `GET /api/ImageOptimizeProxy`

**Query Parameters:**
- `url` (required) - URL of the image to optimize
- `w` - Width (max 1024)
- `h` - Height (max 1024)
- `format` - Output format (default: webp)
- `quality` - Quality 1-100 (default: 75)

### IGDB

Retrieves game metadata from the IGDB (Internet Game Database) API, optimized for live streaming applications.

**Endpoint:** `GET /api/IGDB`

**Actions:**

#### Search for games
```
GET /api/IGDB?action=search&q=game-name&limit=10
```

#### Get game by ID
```
GET /api/IGDB?action=get&id=1942
```

#### Get game by slug
```
GET /api/IGDB?action=slug&slug=the-witcher-3-wild-hunt
```

#### Get popular games
```
GET /api/IGDB?action=popular&limit=10
```

#### Get recently released games
```
GET /api/IGDB?action=recent&limit=10
```

#### Get upcoming games
```
GET /api/IGDB?action=upcoming&limit=10
```

**Response includes:**
- Game name, summary, storyline
- Cover images (multiple sizes)
- Age ratings (ESRB, PEGI, etc.)
- Genres and themes
- Platforms
- Game modes (single player, multiplayer, etc.)
- Developer and publisher information with logos and websites
- Screenshots and artworks
- Video trailers (YouTube links)
- Official websites and social media links
- Release date and ratings
- Similar games
- Franchise/collection information
- Player perspectives
- Multiplayer mode details

## Environment Variables

### Required for IGDB
- `IGDB_CLIENT_ID` - Twitch Developer Client ID
- `IGDB_CLIENT_SECRET` - Twitch Developer Client Secret

These should be stored in Azure Key Vault for production deployments.

## Local Development

1. Copy `local.settings.json.example` to `local.settings.json`
2. Fill in your IGDB credentials
3. Run `npm install`
4. Run `npm start`

## Deployment

The function app reads IGDB credentials from environment variables, which should be configured as Key Vault references in Azure for production.