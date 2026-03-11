const { mediaCollection, mediaMetadata, resultResponse } = require('../xml');
const client = require('../client');

// Static browse hierarchy nodes
const STATIC = {
  root: [
    { id: 'my-library', itemType: 'container', title: 'My Library' },
    { id: 'browse', itemType: 'container', title: 'Browse' },
  ],
  'my-library': [
    { id: 'playlists', itemType: 'container', title: 'Playlists' },
    { id: 'albums', itemType: 'container', title: 'Albums' },
    { id: 'artists', itemType: 'container', title: 'Artists' },
    { id: 'liked-songs', itemType: 'container', title: 'Liked Songs' },
  ],
  browse: [
    { id: 'new-releases', itemType: 'container', title: 'New Releases' },
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

async function getMetadata({ id, index, count }) {
  console.log(`[getMetadata] id=${id}`);

  if (!id) {
    console.error(`[getMetadata] id is null`);
    return resultResponse('getMetadata', [], 0, 0);
  }

  // Static containers
  if (STATIC[id]) {
    const items = STATIC[id].map(item => mediaCollection(item));
    return resultResponse('getMetadata', items, 0, items.length);
  }

  // Search categories
  if (id === 'search') {
    const items = [mediaCollection({ id: 'search:all', itemType: 'search', title: 'All' })];
    return resultResponse('getMetadata', items, 0, items.length);
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
          artist: a.subtitle || '',
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

  if (id === 'new-releases') {
    try {
      const featured = await client.getFeatured();
      const items = [];
      const seen = new Set();

      function addAlbum(c) {
        if (!c || !c.id || seen.has(c.id)) return;
        seen.add(c.id);
        items.push(mediaCollection({
          id: `album:${c.id}`,
          itemType: 'album',
          title: c.title || c.name || '',
          artist: c.subtitle || '',
          albumArtURI: c.cover_url || c.img || '',
          canPlay: true,
          canEnumerate: true,
        }));
      }

      for (const key of Object.keys(featured)) {
        if (['errors', 'device_id', 'meta', 'auth', 'flash'].includes(key)) continue;
        const val = featured[key];
        if (!val) continue;
        if (Array.isArray(val)) {
          for (const c of val) addAlbum(c);
        } else if (val && typeof val === 'object') {
          const tiles = val.tiles || val.data || val.items || [];
          if (Array.isArray(tiles)) {
            for (const c of tiles) addAlbum(c);
          }
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
      if (tracks.length > 0) {
        console.log(`[getMetadata] playlist track[0] id=${tracks[0].id} content_id=${tracks[0].content_id}`);
      }
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
          artist: a.subtitle || '',
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
