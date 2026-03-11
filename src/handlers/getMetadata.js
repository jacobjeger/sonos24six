const { mediaCollection, mediaMetadata, resultResponse } = require('../xml');
const client = require('../client');

// Static browse hierarchy nodes
const STATIC = {
  root: [
    { id: 'my-library', itemType: 'container', title: 'My Library' },
    { id: 'browse', itemType: 'container', title: 'Browse' },
    { id: 'search', itemType: 'search', title: 'Search' },
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

function trackToMetadata(track) {
  const artist = (track.artists && track.artists[0] && track.artists[0].name) ||
                 track.subtitle || '';
  const album = (track.collection && track.collection.title) || '';
  return mediaMetadata({
    id: `track:${track.id}`,
    title: track.title,
    artist,
    album,
    albumArtURI: track.img || '',
    duration: track.length || 0,
  });
}

async function getMetadata({ id, index, count }) {
  // Static containers
  if (STATIC[id]) {
    const items = STATIC[id].map(item => mediaCollection(item));
    return resultResponse('getMetadata', items, 0, items.length);
  }

  // Search categories — Sonos calls getMetadata(id=search) to get searchable types
  if (id === 'search') {
    const categories = [
      { id: 'search:playlists', itemType: 'search', title: 'Playlists' },
      { id: 'search:albums', itemType: 'search', title: 'Albums' },
      { id: 'search:artists', itemType: 'search', title: 'Artists' },
      { id: 'search:tracks', itemType: 'search', title: 'Tracks' },
    ];
    const items = categories.map(c => mediaCollection(c));
    return resultResponse('getMetadata', items, 0, items.length);
  }

  // Dynamic containers
  if (id === 'playlists') {
    const playlists = await client.getPlaylists();
    const items = playlists.map(p => mediaCollection({
      id: `playlist:${p.id}`,
      itemType: 'playlist',
      title: p.title,
      albumArtURI: p.img || '',
      canPlay: true,
      canEnumerate: true,
    }));
    const sliced = items.slice(index, index + count);
    return resultResponse('getMetadata', sliced, index, items.length);
  }

  if (id === 'albums') {
    const albums = await client.getAlbums();
    const items = albums.map(a => mediaCollection({
      id: `album:${a.id}`,
      itemType: 'album',
      title: a.title,
      albumArtURI: a.img || '',
      canPlay: true,
      canEnumerate: true,
    }));
    const sliced = items.slice(index, index + count);
    return resultResponse('getMetadata', sliced, index, items.length);
  }

  if (id === 'artists') {
    const artists = await client.getArtists();
    const items = artists.map(a => mediaCollection({
      id: `artist:${a.id}`,
      itemType: 'artist',
      title: a.name,
      albumArtURI: a.img || '',
      canPlay: false,
      canEnumerate: true,
    }));
    const sliced = items.slice(index, index + count);
    return resultResponse('getMetadata', sliced, index, items.length);
  }

  if (id === 'liked-songs') {
    const songs = await client.getLikedSongs();
    const items = songs.map(s => trackToMetadata(s));
    const sliced = items.slice(index, index + count);
    return resultResponse('getMetadata', sliced, index, items.length);
  }

  if (id === 'new-releases') {
    const featured = await client.getFeatured();
    const items = [];
    if (Array.isArray(featured)) {
      for (const section of featured) {
        const collections = section.data || [];
        for (const c of collections) {
          items.push(mediaCollection({
            id: `album:${c.id}`,
            itemType: 'album',
            title: c.title,
            albumArtURI: c.img || '',
            canPlay: true,
            canEnumerate: true,
          }));
        }
      }
    }
    const sliced = items.slice(index, index + count);
    return resultResponse('getMetadata', sliced, index, items.length);
  }

  // Playlist contents
  if (id.startsWith('playlist:')) {
    const playlistId = id.split(':')[1];
    const data = await client.getPlaylistContents(playlistId);
    const tracks = data.contents || [];
    const items = tracks.map(t => trackToMetadata(t));
    const sliced = items.slice(index, index + count);
    return resultResponse('getMetadata', sliced, index, items.length);
  }

  // Album contents
  if (id.startsWith('album:')) {
    const albumId = id.split(':')[1];
    const data = await client.getAlbumContents(albumId);
    const tracks = data.contents || [];
    const items = tracks.map(t => trackToMetadata(t));
    const sliced = items.slice(index, index + count);
    return resultResponse('getMetadata', sliced, index, items.length);
  }

  // Fallback: empty result
  return resultResponse('getMetadata', [], 0, 0);
}

module.exports = getMetadata;
