import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import axios from "axios";

// Token cache for IGDB authentication
interface TokenCache {
    accessToken: string;
    expiresAt: number;
}

let tokenCache: TokenCache | null = null;

/**
 * Get or refresh the IGDB access token using Twitch OAuth2
 */
async function getAccessToken(context: InvocationContext): Promise<string> {
    const clientId = process.env.IGDB_CLIENT_ID;
    const clientSecret = process.env.IGDB_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error("IGDB_CLIENT_ID and IGDB_CLIENT_SECRET environment variables are required");
    }

    // Check if we have a valid cached token (with 5 minute buffer)
    const now = Date.now();
    if (tokenCache && tokenCache.expiresAt > now + 300000) {
        return tokenCache.accessToken;
    }

    context.log("Fetching new IGDB access token...");

    try {
        const response = await axios.post(
            `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`
        );

        const { access_token, expires_in } = response.data;

        tokenCache = {
            accessToken: access_token,
            expiresAt: now + (expires_in * 1000)
        };

        context.log("Successfully obtained new IGDB access token");
        return access_token;
    } catch (error) {
        context.error("Failed to obtain IGDB access token:", error);
        throw new Error("Failed to authenticate with IGDB");
    }
}

/**
 * Make a request to the IGDB API
 */
async function igdbRequest(
    endpoint: string,
    body: string,
    context: InvocationContext
): Promise<any> {
    const clientId = process.env.IGDB_CLIENT_ID;
    const accessToken = await getAccessToken(context);

    const response = await axios.post(
        `https://api.igdb.com/v4/${endpoint}`,
        body,
        {
            headers: {
                "Client-ID": clientId!,
                "Authorization": `Bearer ${accessToken}`,
                "Accept": "application/json"
            }
        }
    );

    return response.data;
}

/**
 * Build the image URL from IGDB image_id
 * Sizes: cover_small, cover_big, screenshot_med, screenshot_big, screenshot_huge, thumb, micro, 720p, 1080p
 */
function buildImageUrl(imageId: string, size: string = "cover_big"): string {
    return `https://images.igdb.com/igdb/image/upload/t_${size}/${imageId}.jpg`;
}

/**
 * Transform raw IGDB game data into a cleaner format for streaming use
 */
function transformGameData(game: any): any {
    const result: any = {
        id: game.id,
        name: game.name,
        slug: game.slug,
        summary: game.summary,
        storyline: game.storyline,
        url: game.url
    };

    // Cover image
    if (game.cover) {
        result.cover = {
            id: game.cover.id,
            imageId: game.cover.image_id,
            url: buildImageUrl(game.cover.image_id, "cover_big"),
            urlSmall: buildImageUrl(game.cover.image_id, "cover_small"),
            url720p: buildImageUrl(game.cover.image_id, "720p")
        };
    }

    // Age ratings
    if (game.age_ratings && game.age_ratings.length > 0) {
        result.ageRatings = game.age_ratings.map((rating: any) => ({
            id: rating.id,
            category: getRatingCategoryName(rating.category),
            rating: getRatingName(rating.rating),
            ratingCoverUrl: rating.rating_cover_url,
            synopsis: rating.synopsis
        }));
    }

    // Genres
    if (game.genres && game.genres.length > 0) {
        result.genres = game.genres.map((genre: any) => ({
            id: genre.id,
            name: genre.name,
            slug: genre.slug
        }));
    }

    // Themes
    if (game.themes && game.themes.length > 0) {
        result.themes = game.themes.map((theme: any) => ({
            id: theme.id,
            name: theme.name,
            slug: theme.slug
        }));
    }

    // Platforms
    if (game.platforms && game.platforms.length > 0) {
        result.platforms = game.platforms.map((platform: any) => ({
            id: platform.id,
            name: platform.name,
            abbreviation: platform.abbreviation
        }));
    }

    // Game modes
    if (game.game_modes && game.game_modes.length > 0) {
        result.gameModes = game.game_modes.map((mode: any) => ({
            id: mode.id,
            name: mode.name
        }));
    }

    // Involved companies (developers, publishers)
    if (game.involved_companies && game.involved_companies.length > 0) {
        result.companies = game.involved_companies.map((ic: any) => {
            const company: any = {
                id: ic.company?.id,
                name: ic.company?.name,
                isDeveloper: ic.developer,
                isPublisher: ic.publisher,
                isPorting: ic.porting,
                isSupporting: ic.supporting
            };

            // Company logo
            if (ic.company?.logo) {
                company.logo = {
                    imageId: ic.company.logo.image_id,
                    url: buildImageUrl(ic.company.logo.image_id, "logo_med")
                };
            }

            // Company websites
            if (ic.company?.websites && ic.company.websites.length > 0) {
                company.websites = ic.company.websites.map((site: any) => ({
                    category: getWebsiteCategoryName(site.category),
                    url: site.url
                }));
            }

            return company;
        });

        // Separate developers and publishers for convenience
        result.developers = result.companies.filter((c: any) => c.isDeveloper);
        result.publishers = result.companies.filter((c: any) => c.isPublisher);
    }

    // Screenshots
    if (game.screenshots && game.screenshots.length > 0) {
        result.screenshots = game.screenshots.map((ss: any) => ({
            id: ss.id,
            imageId: ss.image_id,
            url: buildImageUrl(ss.image_id, "screenshot_big"),
            urlHuge: buildImageUrl(ss.image_id, "screenshot_huge"),
            url720p: buildImageUrl(ss.image_id, "720p")
        }));
    }

    // Artworks
    if (game.artworks && game.artworks.length > 0) {
        result.artworks = game.artworks.map((art: any) => ({
            id: art.id,
            imageId: art.image_id,
            url: buildImageUrl(art.image_id, "screenshot_big"),
            url720p: buildImageUrl(art.image_id, "720p"),
            url1080p: buildImageUrl(art.image_id, "1080p")
        }));
    }

    // Videos (YouTube)
    if (game.videos && game.videos.length > 0) {
        result.videos = game.videos.map((video: any) => ({
            id: video.id,
            name: video.name,
            videoId: video.video_id,
            youtubeUrl: `https://www.youtube.com/watch?v=${video.video_id}`,
            thumbnailUrl: `https://img.youtube.com/vi/${video.video_id}/hqdefault.jpg`
        }));
    }

    // Websites
    if (game.websites && game.websites.length > 0) {
        result.websites = game.websites.map((site: any) => ({
            category: getWebsiteCategoryName(site.category),
            url: site.url
        }));

        // Extract specific important links
        result.officialWebsite = game.websites.find((s: any) => s.category === 1)?.url;
        result.steamUrl = game.websites.find((s: any) => s.category === 13)?.url;
        result.twitchUrl = game.websites.find((s: any) => s.category === 6)?.url;
    }

    // First release date
    if (game.first_release_date) {
        result.firstReleaseDate = new Date(game.first_release_date * 1000).toISOString();
        result.releaseYear = new Date(game.first_release_date * 1000).getFullYear();
    }

    // Ratings
    if (game.rating) {
        result.rating = Math.round(game.rating * 10) / 10;
        result.ratingCount = game.rating_count;
    }

    if (game.aggregated_rating) {
        result.criticRating = Math.round(game.aggregated_rating * 10) / 10;
        result.criticRatingCount = game.aggregated_rating_count;
    }

    if (game.total_rating) {
        result.totalRating = Math.round(game.total_rating * 10) / 10;
        result.totalRatingCount = game.total_rating_count;
    }

    // Similar games (just IDs and names for reference)
    if (game.similar_games && game.similar_games.length > 0) {
        result.similarGames = game.similar_games.map((sg: any) => ({
            id: sg.id,
            name: sg.name,
            slug: sg.slug,
            cover: sg.cover ? {
                imageId: sg.cover.image_id,
                url: buildImageUrl(sg.cover.image_id, "cover_small")
            } : null
        }));
    }

    // Franchise
    if (game.franchise) {
        result.franchise = {
            id: game.franchise.id,
            name: game.franchise.name
        };
    }

    // Collection (series)
    if (game.collection) {
        result.collection = {
            id: game.collection.id,
            name: game.collection.name
        };
    }

    // Player perspectives
    if (game.player_perspectives && game.player_perspectives.length > 0) {
        result.playerPerspectives = game.player_perspectives.map((pp: any) => ({
            id: pp.id,
            name: pp.name
        }));
    }

    // Multiplayer modes
    if (game.multiplayer_modes && game.multiplayer_modes.length > 0) {
        result.multiplayerModes = game.multiplayer_modes.map((mm: any) => ({
            campaignCoop: mm.campaigncoop,
            dropIn: mm.dropin,
            lanCoop: mm.lancoop,
            offlineCoop: mm.offlinecoop,
            offlineCoopMax: mm.offlinecoopmax,
            offlineMax: mm.offlinemax,
            onlineCoop: mm.onlinecoop,
            onlineCoopMax: mm.onlinecoopmax,
            onlineMax: mm.onlinemax,
            splitscreen: mm.splitscreen,
            splitscreenOnline: mm.splitscreenonline
        }));
    }

    return result;
}

/**
 * Get human-readable rating category name
 */
function getRatingCategoryName(category: number): string {
    const categories: { [key: number]: string } = {
        1: "ESRB",
        2: "PEGI",
        3: "CERO",
        4: "USK",
        5: "GRAC",
        6: "CLASS_IND",
        7: "ACB"
    };
    return categories[category] || `Unknown (${category})`;
}

/**
 * Get human-readable rating name
 */
function getRatingName(rating: number): string {
    const ratings: { [key: number]: string } = {
        1: "Three",
        2: "Seven",
        3: "Twelve",
        4: "Sixteen",
        5: "Eighteen",
        6: "RP",
        7: "EC",
        8: "E",
        9: "E10",
        10: "T",
        11: "M",
        12: "AO",
        13: "CERO A",
        14: "CERO B",
        15: "CERO C",
        16: "CERO D",
        17: "CERO Z",
        18: "USK 0",
        19: "USK 6",
        20: "USK 12",
        21: "USK 16",
        22: "USK 18",
        23: "GRAC All",
        24: "GRAC 12",
        25: "GRAC 15",
        26: "GRAC 18",
        27: "GRAC Testing",
        28: "CLASS_IND L",
        29: "CLASS_IND 10",
        30: "CLASS_IND 12",
        31: "CLASS_IND 14",
        32: "CLASS_IND 16",
        33: "CLASS_IND 18",
        34: "ACB G",
        35: "ACB PG",
        36: "ACB M",
        37: "ACB MA15",
        38: "ACB R18",
        39: "ACB RC"
    };
    return ratings[rating] || `Unknown (${rating})`;
}

/**
 * Get human-readable website category name
 */
function getWebsiteCategoryName(category: number): string {
    const categories: { [key: number]: string } = {
        1: "official",
        2: "wikia",
        3: "wikipedia",
        4: "facebook",
        5: "twitter",
        6: "twitch",
        8: "instagram",
        9: "youtube",
        10: "iphone",
        11: "ipad",
        12: "android",
        13: "steam",
        14: "reddit",
        15: "itch",
        16: "epicgames",
        17: "gog",
        18: "discord",
        19: "bluesky"
    };
    return categories[category] || `unknown (${category})`;
}

/**
 * Search for games by name
 */
export async function IGDB(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    context.log(`IGDB API request for url "${request.url}"`);

    try {
        const action = request.query.get("action") || "search";
        const limit = Math.min(parseInt(request.query.get("limit") || "10"), 50);

        // Fields to request - comprehensive for streaming use case
        const gameFields = `
            fields 
                name, slug, summary, storyline, url,
                cover.image_id,
                age_ratings.category, age_ratings.rating, age_ratings.rating_cover_url, age_ratings.synopsis,
                genres.name, genres.slug,
                themes.name, themes.slug,
                platforms.name, platforms.abbreviation,
                game_modes.name,
                involved_companies.developer, involved_companies.publisher, involved_companies.porting, involved_companies.supporting,
                involved_companies.company.name, involved_companies.company.logo.image_id,
                involved_companies.company.websites.category, involved_companies.company.websites.url,
                screenshots.image_id,
                artworks.image_id,
                videos.name, videos.video_id,
                websites.category, websites.url,
                first_release_date, rating, rating_count,
                aggregated_rating, aggregated_rating_count,
                total_rating, total_rating_count,
                similar_games.name, similar_games.slug, similar_games.cover.image_id,
                franchise.name,
                collection.name,
                player_perspectives.name,
                multiplayer_modes.*;
        `.replace(/\s+/g, " ").trim();

        let result: any;

        switch (action) {
            case "search": {
                const query = request.query.get("q") || request.query.get("query");
                if (!query) {
                    return { 
                        status: 400, 
                        jsonBody: { error: "Missing 'q' or 'query' parameter for search" }
                    };
                }

                const body = `
                    ${gameFields}
                    search "${query}";
                    where version_parent = null & themes != (42);
                    limit ${limit};
                `;

                const games = await igdbRequest("games", body, context);
                result = {
                    action: "search",
                    query,
                    count: games.length,
                    games: games.map(transformGameData)
                };
                break;
            }

            case "get": {
                const id = request.query.get("id");
                if (!id) {
                    return { 
                        status: 400, 
                        jsonBody: { error: "Missing 'id' parameter" }
                    };
                }

                const body = `
                    ${gameFields}
                    where id = ${id};
                `;

                const games = await igdbRequest("games", body, context);
                if (games.length === 0) {
                    return { 
                        status: 404, 
                        jsonBody: { error: "Game not found" }
                    };
                }

                result = transformGameData(games[0]);
                break;
            }

            case "slug": {
                const slug = request.query.get("slug");
                if (!slug) {
                    return { 
                        status: 400, 
                        jsonBody: { error: "Missing 'slug' parameter" }
                    };
                }

                const body = `
                    ${gameFields}
                    where slug = "${slug}";
                `;

                const games = await igdbRequest("games", body, context);
                if (games.length === 0) {
                    return { 
                        status: 404, 
                        jsonBody: { error: "Game not found" }
                    };
                }

                result = transformGameData(games[0]);
                break;
            }

            case "popular": {
                // Get popular games based on rating and rating count
                const body = `
                    ${gameFields}
                    where rating_count > 100 & themes != (42);
                    sort rating desc;
                    limit ${limit};
                `;

                const games = await igdbRequest("games", body, context);
                result = {
                    action: "popular",
                    count: games.length,
                    games: games.map(transformGameData)
                };
                break;
            }

            case "recent": {
                // Get recently released games
                const now = Math.floor(Date.now() / 1000);
                const body = `
                    ${gameFields}
                    where first_release_date < ${now} & first_release_date != null & themes != (42);
                    sort first_release_date desc;
                    limit ${limit};
                `;

                const games = await igdbRequest("games", body, context);
                result = {
                    action: "recent",
                    count: games.length,
                    games: games.map(transformGameData)
                };
                break;
            }

            case "upcoming": {
                // Get upcoming games
                const now = Math.floor(Date.now() / 1000);
                const body = `
                    ${gameFields}
                    where first_release_date > ${now} & themes != (42);
                    sort first_release_date asc;
                    limit ${limit};
                `;

                const games = await igdbRequest("games", body, context);
                result = {
                    action: "upcoming",
                    count: games.length,
                    games: games.map(transformGameData)
                };
                break;
            }

            default:
                return { 
                    status: 400, 
                    jsonBody: { 
                        error: `Unknown action: ${action}`,
                        availableActions: ["search", "get", "slug", "popular", "recent", "upcoming"]
                    }
                };
        }

        return {
            status: 200,
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "public, max-age=3600" // 1 hour cache
            },
            jsonBody: result
        };

    } catch (error: any) {
        context.error("IGDB API error:", error);
        
        if (error.response) {
            return {
                status: error.response.status || 500,
                jsonBody: {
                    error: "IGDB API error",
                    message: error.response.data || error.message
                }
            };
        }

        return {
            status: 500,
            jsonBody: {
                error: "Internal server error",
                message: error.message
            }
        };
    }
}

app.http('IGDB', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: IGDB
});
