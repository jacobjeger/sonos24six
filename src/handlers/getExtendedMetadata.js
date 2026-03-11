const { simpleResponse, mediaMetadata, mediaCollection } = require('../xml');
const { getCachedTrack, getCachedAlbum, getCachedArtist, getCachedPlaylist,
        getTrackInfo, getAlbumContents, getArtistPage, getPlaylistContents,
        cacheAlbum, cacheArtist, cachePlaylist } = require('../client');

function extractArtist(track) {
  if (!track) return '';
  if (track.artists && track.artists.length > 0 && track.artists[0].name) return track.artists[0].name;
  if (track.subtitle) return track.subtitle;
  return '';
}

function extractAlbum(track) {
  if (!track) return '';
  if (track.collection) return track.collection.title || track.collection.name || '';
  if (track.album_title) return track.album_title;
  return '';
}

// Static container titles — Sonos calls getExtendedMetadata to resolve container names
const STATIC_CONTAINERS = {
  root: 'Root',
  'my-library': 'My Library',
  browse: 'Browse',
  playlists: 'Playlists',
  albums: 'Albums',
  artists: 'Artists',
  'liked-songs': 'Liked Songs',
  'new-releases': 'New Releases',
  search: 'Search',
};

async function getExtendedMetadata({ id }) {
  console.log(`[getExtendedMetadata] id=${id}`);

  if (!id) {
    console.log(`[getExtendedMetadata] ERROR: id is null/undefined`);
    const xml = mediaCollection({ id: '', itemType: 'container', title: '', albumArtURI: '' });
    return simpleResponse('getExtendedMetadata',
      `      <getExtendedMetadataResult>\n${xml}\n      </getExtendedMetadataResult>`);
  }

  // Static containers (root, my-library, browse, playlists, albums, etc.)
  if (STATIC_CONTAINERS[id]) {
    const xml = mediaCollection({
      id,
      itemType: id === 'search' ? 'search' : 'container',
      title: STATIC_CONTAINERS[id],
      albumArtURI: '',
      canPlay: false,
      canEnumerate: true,
    });
    return simpleResponse('getExtendedMetadata',
      `      <getExtendedMetadataResult>\n${xml}\n      </getExtendedMetadataResult>`);
  }

  if (id.startsWith('track:')) {
    const trackId = id.split(':')[1];
    let track = getCachedTrack(trackId);

    // If cached but incomplete, re-fetch
    if (track && (!extractArtist(track) || !(track.img || track.content_image_url))) {
      console.log(`[getExtendedMetadata] Track ${trackId} cached but incomplete, re-fetching...`);
      try {
        const fresh = await getTrackInfo(trackId);
        if (fresh) track = fresh;
      } catch (err) {
        console.log(`[getExtendedMetadata] Re-fetch failed: ${err.message}`);
      }
    }

    // Fallback: fetch from API if not cached
    if (!track) {
      console.log(`[getExtendedMetadata] Track ${trackId} not in cache, fetching...`);
      try {
        track = await getTrackInfo(trackId);
      } catch (err) {
        console.log(`[getExtendedMetadata] Failed to fetch track ${trackId}: ${err.message}`);
      }
    }

    const title = (track && (track.title || track.name)) || `Track ${trackId}`;
    const artist = track ? extractArtist(track) : '';
    const album = track ? extractAlbum(track) : '';
    const albumArtURI = (track && (track.img || track.content_image_url)) || '';
    const duration = (track && (track.length || track.length_in_seconds)) || 0;

    const xml = mediaMetadata({ id, title, artist, album, albumArtURI, duration });
    return simpleResponse('getExtendedMetadata',
      `      <getExtendedMetadataResult>\n${xml}\n      </getExtendedMetadataResult>`);
  }

  // Album — look up from cache or fetch
  if (id.startsWith('album:')) {
    const albumId = id.split(':')[1];
    let album = getCachedAlbum(albumId);

    if (!album) {
      console.log(`[getExtendedMetadata] Album ${albumId} not in cache, fetching...`);
      try {
        const data = await getAlbumContents(albumId);
        if (data && data.id) {
          cacheAlbum(data);
          album = data;
        }
      } catch (err) {
        console.log(`[getExtendedMetadata] Failed to fetch album ${albumId}: ${err.message}`);
      }
    }

    const xml = mediaCollection({
      id,
      itemType: 'album',
      title: (album && (album.title || album.name)) || `Album ${albumId}`,
      artist: (album && album.subtitle) || '',
      albumArtURI: (album && (album.cover_url || album.img)) || '',
      canPlay: true,
      canEnumerate: true,
    });
    return simpleResponse('getExtendedMetadata',
      `      <getExtendedMetadataResult>\n${xml}\n      </getExtendedMetadataResult>`);
  }

  // Playlist — look up from cache or fetch
  if (id.startsWith('playlist:')) {
    const playlistId = id.split(':')[1];
    let playlist = getCachedPlaylist(playlistId);

    if (!playlist) {
      console.log(`[getExtendedMetadata] Playlist ${playlistId} not in cache, fetching...`);
      try {
        const data = await getPlaylistContents(playlistId);
        if (data && data.id) {
          cachePlaylist(data);
          playlist = data;
        }
      } catch (err) {
        console.log(`[getExtendedMetadata] Failed to fetch playlist ${playlistId}: ${err.message}`);
      }
    }

    const xml = mediaCollection({
      id,
      itemType: 'playlist',
      title: (playlist && (playlist.title || playlist.name)) || `Playlist ${playlistId}`,
      albumArtURI: (playlist && (playlist.cover_url || playlist.img)) || '',
      canPlay: true,
      canEnumerate: true,
    });
    return simpleResponse('getExtendedMetadata',
      `      <getExtendedMetadataResult>\n${xml}\n      </getExtendedMetadataResult>`);
  }

  // Artist — look up from cache or fetch
  if (id.startsWith('artist:')) {
    const artistId = id.split(':')[1];
    let artist = getCachedArtist(artistId);

    if (!artist) {
      console.log(`[getExtendedMetadata] Artist ${artistId} not in cache, fetching...`);
      try {
        const data = await getArtistPage(artistId);
        if (data && data.artist) {
          artist = data.artist;
          cacheArtist(artist);
        }
      } catch (err) {
        console.log(`[getExtendedMetadata] Failed to fetch artist ${artistId}: ${err.message}`);
      }
    }

    const xml = mediaCollection({
      id,
      itemType: 'artist',
      title: (artist && (artist.name || artist.title)) || `Artist ${artistId}`,
      albumArtURI: (artist && (artist.img || artist.cover_url)) || '',
      canPlay: false,
      canEnumerate: true,
    });
    return simpleResponse('getExtendedMetadata',
      `      <getExtendedMetadataResult>\n${xml}\n      </getExtendedMetadataResult>`);
  }

  // Fallback
  const xml = mediaCollection({
    id,
    itemType: 'container',
    title: id,
    albumArtURI: '',
    canPlay: false,
    canEnumerate: true,
  });
  return simpleResponse('getExtendedMetadata',
    `      <getExtendedMetadataResult>\n${xml}\n      </getExtendedMetadataResult>`);
}

module.exports = getExtendedMetadata;
