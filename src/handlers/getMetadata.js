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
  // Cache every track we see so getMediaMetadata can look it up later
  client.cacheTrack(track);

  return mediaMetadata({
    id: `track:${track.id}`,
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
  console.log(`[getMetadata] id=${id} index=${index} count=${count}`);

  // Static containers
  if (STATIC[id]) {
    const items = STATIC[id].map(item => mediaCollection(item));
    return resultResponse('getMetadata', items, 0, items.length);
  }

  // Search categories — Sonos calls getMetadata(id=search) to get searchable types
  if (id === 'search') {
    const categories = [
      { id: 'search:all', itemType: 'search', title: 'All' },
    ];
    const items = categories.map(c => mediaCollection(c));
    return resultResponse('getMetadata', items, 0, items.length);
  }

  // Dynamic containers — Library
  if (id === 'playlists') {
    const playlists = await client.getPlaylists();
    const items = playlists.map(p => mediaCollection({
      id: `playlist:${p.id}`,
      itemType: 'playlist',
      title: p.title || p.name || '',
      albumArtURI: p.img || '',
      canPlay: true,
      canEnumerate: true,
    }));
    const { sliced, total } = paginate(items, index, count);
    return resultResponse('getMetadata', sliced, index, total);
  }

  if (id === 'albums') {
    const albums = await client.getAlbums();
    const items = albums.map(a => {
      client.cacheAlbum(a);
      return mediaCollection({
        id: `album:${a.id}`,
        itemType: 'album',
        title: a.title || a.name || '',
        artist: a.subtitle || '',
        albumArtURI: a.img || '',
        canPlay: true,
        canEnumerate: true,
      });
    });
    const { sliced, total } = paginate(items, index, count);
    return resultResponse('getMetadata', sliced, index, total);
  }

  if (id === 'artists') {
    const artists = await client.getArtists();
    const items = artists.map(a => mediaCollection({
      id: `artist:${a.id}`,
      itemType: 'artist',
      title: a.name || a.title || '',
      albumArtURI: a.img || '',
      canPlay: false,
      canEnumerate: true,
    }));
    const { sliced, total } = paginate(items, index, count);
    return resultResponse('getMetadata', sliced, index, total);
  }

  if (id === 'liked-songs') {
    const songs = await client.getLikedSongs();
    const items = songs.map(s => trackToMetadata(s));
    const { sliced, total } = paginate(items, index, count);
    return resultResponse('getMetadata', sliced, index, total);
  }

  if (id === 'new-releases') {
    const featured = await client.getFeatured();
    const items = [];
    if (Array.isArray(featured)) {
      for (const section of featured) {
        const collections = section.data || section.collections || [];
        for (const c of collections) {
          items.push(mediaCollection({
            id: `album:${c.id}`,
            itemType: 'album',
            title: c.title || c.name || '',
            albumArtURI: c.img || '',
            canPlay: true,
            canEnumerate: true,
          }));
        }
      }
    }
    const { sliced, total } = paginate(items, index, count);
    return resultResponse('getMetadata', sliced, index, total);
  }

  // Playlist contents
  if (id.startsWith('playlist:')) {
    const playlistId = id.split(':')[1];
    const data = await client.getPlaylistContents(playlistId);
    const tracks = data.contents || [];
    const items = tracks.map(t => trackToMetadata(t));
    const { sliced, total } = paginate(items, index, count);
    return resultResponse('getMetadata', sliced, index, total);
  }

  // Album contents
  if (id.startsWith('album:')) {
    const albumId = id.split(':')[1];
    const data = await client.getAlbumContents(albumId);
    // Cache the album metadata from the response
    if (data && data.id) client.cacheAlbum(data);
    const tracks = data.contents || [];
    const items = tracks.map(t => trackToMetadata(t));
    const { sliced, total } = paginate(items, index, count);
    return resultResponse('getMetadata', sliced, index, total);
  }

  // Artist — show their albums
  if (id.startsWith('artist:')) {
    const artistId = id.split(':')[1];
    console.log(`[getMetadata] Fetching artist page for ${artistId}`);
    const { collections } = await client.getArtistPage(artistId);
    const albumList = Array.isArray(collections) ? collections :
                      (collections && collections.data) || [];
    const items = albumList.map(a => {
      client.cacheAlbum(a);
      return mediaCollection({
        id: `album:${a.id}`,
        itemType: 'album',
        title: a.title || a.name || '',
        albumArtURI: a.img || '',
        canPlay: true,
        canEnumerate: true,
      });
    });
    const { sliced, total } = paginate(items, index, count);
    return resultResponse('getMetadata', sliced, index, total);
  }

  // Fallback: empty result
  console.log(`[getMetadata] Unknown id: ${id}`);
  return resultResponse('getMetadata', [], 0, 0);
}

module.exports = getMetadata;
