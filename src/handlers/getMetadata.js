const { mediaCollection, mediaMetadata, resultResponse } = require('../xml');
const client = require('../client');

// Static browse hierarchy nodes
const STATIC = {
  'my-library': [
    { id: 'playlists', itemType: 'container', title: 'Playlists' },
    { id: 'albums', itemType: 'container', title: 'Albums' },
    { id: 'artists', itemType: 'container', title: 'Artists' },
    { id: 'liked-songs', itemType: 'container', title: 'Liked Songs' },
  ],
};

function extractArtist(track) {
  if (!track) return '';
  if (track.artists && track.artists.length > 0 && track.artists[0].name) return track.artists[0].name;
  if (track.subtitle) return track.subtitle;
  if (track.collection && track.collection.artists && track.collection.artists.length > 0) return track.collection.artists[0].name || '';
  return '';
}

function extractAlbum(track) {
  if (!track) return '';
  if (track.collection) return track.collection.title || track.collection.name || '';
  if (track.album_title) return track.album_title;
  return '';
}

function extractAlbumArtist(album) {
  if (!album) return '';
  if (album.subtitle) return album.subtitle;
  if (album.artists && album.artists.length > 0 && album.artists[0].name) return album.artists[0].name;
  return '';
}

function trackToMetadata(track) {
  client.cacheTrack(track);
  const trackId = track.content_id || track.id;
  return mediaMetadata({
    id: `track:${trackId}`,
    title: track.title || track.name || '',
    artist: extractArtist(track),
    album: extractAlbum(track),
    albumArtURI: track.img || track.content_image_url || '',
    duration: track.length || track.length_in_seconds || 0,
  });
}

function paginate(items, index, count) {
  const sliced = items.slice(index, index + count);
  return { sliced, total: items.length };
}

// Helper: extract albums/collections from a featured section value
function extractAlbumsFromSection(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'object') {
    return val.data || val.tiles || val.items || [];
  }
  return [];
}

async function getMetadata({ id, index, count }) {
  console.log(`[getMetadata] id=${id}`);

  if (!id) {
    console.error(`[getMetadata] id is null`);
    return resultResponse('getMetadata', [], 0, 0);
  }

  // Root — My Library + featured browse categories (flat, no sub-containers Sonos can't drill into)
  if (id === 'root') {
    const items = [
      mediaCollection({ id: 'my-library', itemType: 'container', title: 'My Library' }),
      mediaCollection({ id: 'new-releases', itemType: 'container', title: 'New Releases' }),
      mediaCollection({ id: 'albums', itemType: 'container', title: 'All Albums' }),
      mediaCollection({ id: 'artists', itemType: 'container', title: 'All Artists' }),
    ];
    // Add featured categories directly to root
    try {
      const featured = await client.getFeatured();
      for (const key of Object.keys(featured)) {
        if (['errors', 'device_id', 'meta', 'auth', 'flash'].includes(key)) continue;
        const val = featured[key];
        if (!val) continue;
        let sectionItems = [];
        let headline = '';
        if (Array.isArray(val) && val.length > 0 && val[0] && val[0].id) {
          sectionItems = val;
          headline = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        } else if (val && typeof val === 'object' && !Array.isArray(val)) {
          const cat = val.category;
          headline = (typeof cat === 'string' ? cat : (cat && (cat.name || cat.title))) || val.headline || val.title || val.name || `Section ${key}`;
          sectionItems = val.data || val.tiles || val.items || [];
        }
        if (Array.isArray(sectionItems) && sectionItems.length > 0) {
          items.push(mediaCollection({
            id: `featured:${key}`,
            itemType: 'container',
            title: headline,
            albumArtURI: (sectionItems[0] && (sectionItems[0].cover_url || sectionItems[0].img)) || '',
            canPlay: false,
            canEnumerate: true,
          }));
        }
      }
    } catch (err) {
      console.error(`[getMetadata] root featured error:`, err.message);
    }
    return resultResponse('getMetadata', items, 0, items.length);
  }

  // Static containers (my-library)
  if (STATIC[id]) {
    const items = STATIC[id].map(item => mediaCollection(item));
    return resultResponse('getMetadata', items, 0, items.length);
  }

  // Search categories
  if (id === 'search') {
    const items = [mediaCollection({ id: 'search:all', itemType: 'search', title: 'All' })];
    return resultResponse('getMetadata', items, 0, items.length);
  }

  // Browse — dynamically build categories from featured homepage sections
  if (id === 'browse') {
    try {
      const featured = await client.getFeatured();
      const categories = [];

      for (const key of Object.keys(featured)) {
        if (['errors', 'device_id', 'meta', 'auth', 'flash'].includes(key)) continue;
        const val = featured[key];
        if (!val) continue;

        // Determine section title and items
        let sectionItems = [];
        let headline = '';

        if (Array.isArray(val) && val.length > 0 && val[0] && val[0].id) {
          sectionItems = val;
          headline = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        } else if (val && typeof val === 'object' && !Array.isArray(val)) {
          // 24Six uses { category, data } structure
          const cat = val.category;
          headline = (typeof cat === 'string' ? cat : (cat && (cat.name || cat.title))) || val.headline || val.title || val.name || `Section ${key}`;
          sectionItems = val.data || val.tiles || val.items || [];
        }

        if (Array.isArray(sectionItems) && sectionItems.length > 0) {
          categories.push(mediaCollection({
            id: `featured:${key}`,
            itemType: 'container',
            title: headline,
            albumArtURI: (sectionItems[0] && (sectionItems[0].cover_url || sectionItems[0].img)) || '',
            canPlay: false,
            canEnumerate: true,
          }));
        }
      }

      // Fallback: if no featured sections found, show a single "New Releases" folder
      if (categories.length === 0) {
        categories.push(mediaCollection({
          id: 'new-releases',
          itemType: 'container',
          title: 'New Releases',
        }));
      }

      return resultResponse('getMetadata', categories, 0, categories.length);
    } catch (err) {
      console.error(`[getMetadata] browse error:`, err.message);
      return resultResponse('getMetadata', [], 0, 0);
    }
  }

  // Featured section contents — shows albums/playlists from a specific featured homepage section
  if (id && id.startsWith('featured:')) {
    try {
      const sectionKey = id.substring('featured:'.length);
      const featured = await client.getFeatured();
      const val = featured[sectionKey];
      const sectionItems = extractAlbumsFromSection(val);
      const items = [];
      const seen = new Set();

      for (const c of sectionItems) {
        if (!c || !c.id || seen.has(c.id)) continue;
        seen.add(c.id);

        // Determine if it's a playlist, album, or artist based on available fields
        const type = c.type || (c.contents !== undefined ? 'playlist' : 'album');
        if (type === 'artist' || c.is_artist) {
          client.cacheArtist(c);
          items.push(mediaCollection({
            id: `artist:${c.id}`,
            itemType: 'artist',
            title: c.name || c.title || '',
            albumArtURI: c.img || c.cover_url || '',
            canPlay: false,
            canEnumerate: true,
          }));
        } else {
          client.cacheAlbum(c);
          items.push(mediaCollection({
            id: `album:${c.id}`,
            itemType: 'album',
            title: c.title || c.name || '',
            artist: extractAlbumArtist(c),
            albumArtURI: c.cover_url || c.img || '',
            canPlay: true,
            canEnumerate: true,
          }));
        }
      }

      const { sliced, total } = paginate(items, index, count);
      return resultResponse('getMetadata', sliced, index, total);
    } catch (err) {
      console.error(`[getMetadata] featured section error:`, err.message);
      return resultResponse('getMetadata', [], 0, 0);
    }
  }

  // Dynamic containers — Library
  if (id === 'playlists') {
    try {
      const playlists = await client.getPlaylists();
      const items = playlists.map(p => {
        client.cachePlaylist(p);
        return mediaCollection({
          id: `playlist:${p.id}`,
          itemType: 'playlist',
          title: p.title || p.name || '',
          albumArtURI: p.cover_url || p.img || '',
          canPlay: true,
          canEnumerate: true,
        });
      });
      const { sliced, total } = paginate(items, index, count);
      return resultResponse('getMetadata', sliced, index, total);
    } catch (err) {
      console.error(`[getMetadata] playlists error:`, err.message);
      return resultResponse('getMetadata', [], 0, 0);
    }
  }

  if (id === 'albums') {
    try {
      const albums = await client.getAlbums();
      const items = albums.map(a => {
        client.cacheAlbum(a);
        return mediaCollection({
          id: `album:${a.id}`,
          itemType: 'album',
          title: a.title || a.name || '',
          artist: extractAlbumArtist(a),
          albumArtURI: a.cover_url || a.img || '',
          canPlay: true,
          canEnumerate: true,
        });
      });
      const { sliced, total } = paginate(items, index, count);
      return resultResponse('getMetadata', sliced, index, total);
    } catch (err) {
      console.error(`[getMetadata] albums error:`, err.message);
      return resultResponse('getMetadata', [], 0, 0);
    }
  }

  if (id === 'artists') {
    try {
      const artists = await client.getArtists();
      const items = artists.map(a => {
        client.cacheArtist(a);
        return mediaCollection({
          id: `artist:${a.id}`,
          itemType: 'artist',
          title: a.name || a.title || '',
          albumArtURI: a.img || '',
          canPlay: false,
          canEnumerate: true,
        });
      });
      const { sliced, total } = paginate(items, index, count);
      return resultResponse('getMetadata', sliced, index, total);
    } catch (err) {
      console.error(`[getMetadata] artists error:`, err.message);
      return resultResponse('getMetadata', [], 0, 0);
    }
  }

  if (id === 'liked-songs') {
    try {
      const songs = await client.getLikedSongs();
      const items = songs.map(s => trackToMetadata(s));
      const { sliced, total } = paginate(items, index, count);
      return resultResponse('getMetadata', sliced, index, total);
    } catch (err) {
      console.error(`[getMetadata] liked-songs error:`, err.message);
      return resultResponse('getMetadata', [], 0, 0);
    }
  }

  // Legacy new-releases fallback (same as featured:* but fetches all sections)
  if (id === 'new-releases') {
    try {
      const featured = await client.getFeatured();
      const items = [];
      const seen = new Set();

      for (const key of Object.keys(featured)) {
        if (['errors', 'device_id', 'meta', 'auth', 'flash'].includes(key)) continue;
        const sectionItems = extractAlbumsFromSection(featured[key]);
        for (const c of sectionItems) {
          if (!c || !c.id || seen.has(c.id)) continue;
          seen.add(c.id);
          items.push(mediaCollection({
            id: `album:${c.id}`,
            itemType: 'album',
            title: c.title || c.name || '',
            artist: extractAlbumArtist(c),
            albumArtURI: c.cover_url || c.img || '',
            canPlay: true,
            canEnumerate: true,
          }));
        }
      }

      const { sliced, total } = paginate(items, index, count);
      return resultResponse('getMetadata', sliced, index, total);
    } catch (err) {
      console.error(`[getMetadata] new-releases error:`, err.message);
      return resultResponse('getMetadata', [], 0, 0);
    }
  }

  // Playlist contents
  if (id && id.startsWith('playlist:')) {
    try {
      const playlistId = id.split(':')[1];
      const data = await client.getPlaylistContents(playlistId);
      client.cachePlaylist(data);
      const tracks = data.contents || [];
      const items = tracks.map(t => trackToMetadata(t));
      const { sliced, total } = paginate(items, index, count);
      return resultResponse('getMetadata', sliced, index, total);
    } catch (err) {
      console.error(`[getMetadata] playlist error:`, err.message);
      return resultResponse('getMetadata', [], 0, 0);
    }
  }

  // Album contents
  if (id && id.startsWith('album:')) {
    try {
      const albumId = id.split(':')[1];
      const data = await client.getAlbumContents(albumId);
      if (data && data.id) client.cacheAlbum(data);
      const tracks = data.contents || [];
      const items = tracks.map(t => trackToMetadata(t));
      const { sliced, total } = paginate(items, index, count);
      return resultResponse('getMetadata', sliced, index, total);
    } catch (err) {
      console.error(`[getMetadata] album error:`, err.message);
      return resultResponse('getMetadata', [], 0, 0);
    }
  }

  // Artist — show top songs then albums
  if (id && id.startsWith('artist:')) {
    try {
      const artistId = id.split(':')[1];
      const { artist, albums, topSongs, latest, featuredOn } = await client.getArtistPage(artistId);
      if (artist) client.cacheArtist(artist);
      const items = [];
      const seenAlbumIds = new Set();

      for (const s of topSongs) {
        items.push(trackToMetadata(s));
      }

      function addAlbum(a) {
        if (!a || !a.id || seenAlbumIds.has(String(a.id))) return;
        seenAlbumIds.add(String(a.id));
        client.cacheAlbum(a);
        items.push(mediaCollection({
          id: `album:${a.id}`,
          itemType: 'album',
          title: a.title || a.name || '',
          artist: extractAlbumArtist(a),
          albumArtURI: a.cover_url || a.img || '',
          canPlay: true,
          canEnumerate: true,
        }));
      }

      if (latest && latest.id) addAlbum(latest);
      for (const a of albums) addAlbum(a);
      for (const a of featuredOn) addAlbum(a);

      const { sliced, total } = paginate(items, index, count);
      return resultResponse('getMetadata', sliced, index, total);
    } catch (err) {
      console.error(`[getMetadata] artist error:`, err.message);
      return resultResponse('getMetadata', [], 0, 0);
    }
  }

  console.log(`[getMetadata] Unknown id: ${id}`);
  return resultResponse('getMetadata', [], 0, 0);
}

module.exports = getMetadata;
