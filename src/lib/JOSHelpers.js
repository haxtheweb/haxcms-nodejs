const fs = require('fs-extra');
const path = require('path');
const { parse } = require('node-html-parser');
const JSONOutlineSchema = require('./JSONOutlineSchema.js');

const WORDSPERMIN = 225;

function normalizeItems(items) {
  const normalized = [];
  if (Array.isArray(items)) {
    for (let i = 0; i < items.length; i++) {
      if (items[i]) {
        normalized.push(items[i]);
      }
    }
    return normalized;
  }
  if (items && typeof items === 'object') {
    for (const key in items) {
      if (items[key]) {
        normalized.push(items[key]);
      }
    }
  }
  return normalized;
}

function cleanSiteLocation(siteLocation) {
  if (typeof siteLocation !== 'string') {
    return '';
  }
  let normalized = siteLocation.trim();
  if (normalized === '') {
    return '';
  }
  if (normalized.indexOf('/site.json') !== -1) {
    normalized = normalized.replace('/site.json', '');
  }
  if (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function fallbackURL(value = '') {
  return {
    origin: '',
    pathname: value,
    href: value,
    toString: function () {
      return value;
    },
  };
}

function dateToISOTime(value) {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return new Date(0).toISOString();
  }
  return new Date(parsed * 1000).toISOString();
}

function countWords(value) {
  if (typeof value !== 'string') {
    return 0;
  }
  const text = value.trim();
  if (text === '') {
    return 0;
  }
  return text.split(/\s+/).length;
}

function toSitePath(siteLocation) {
  if (typeof siteLocation !== 'string' || siteLocation === '') {
    return '';
  }
  let candidate = siteLocation;
  if (candidate.indexOf('://') !== -1) {
    return '';
  }
  if (candidate.endsWith('/site.json')) {
    return candidate;
  }
  return path.join(candidate, 'site.json');
}

async function resolveSiteData(siteLocation, siteData = null) {
  if (
    siteData &&
    typeof siteData === 'object' &&
    siteData.manifest &&
    siteData.siteDirectory
  ) {
    return siteData;
  }
  if (
    siteLocation &&
    typeof siteLocation === 'object' &&
    siteLocation.manifest &&
    siteLocation.siteDirectory
  ) {
    return siteLocation;
  }
  const manifestPath = toSitePath(siteLocation);
  if (manifestPath === '' || !fs.existsSync(manifestPath)) {
    return null;
  }
  const site = {
    siteDirectory: path.dirname(manifestPath),
    manifest: new JSONOutlineSchema(),
  };
  await site.manifest.load(manifestPath);
  return site;
}

function getOrderedItems(site) {
  if (!site || !site.manifest) {
    return [];
  }
  const items = normalizeItems(site.manifest.items);
  if (typeof site.manifest.orderTree === 'function') {
    return site.manifest.orderTree(items);
  }
  return items;
}

function getBranchItems(site, ancestor = null) {
  if (!site || !site.manifest) {
    return [];
  }
  if (ancestor === null) {
    return getOrderedItems(site);
  }
  if (typeof site.manifest.findBranch === 'function') {
    return normalizeItems(site.manifest.findBranch(ancestor));
  }
  return [];
}

async function getItemHTML(site, item) {
  if (!site || !item || !item.location || !site.siteDirectory) {
    return '';
  }
  const pagePath = path.join(site.siteDirectory, item.location);
  if (!fs.existsSync(pagePath)) {
    return '';
  }
  try {
    return fs.readFileSync(pagePath, {
      encoding: 'utf8',
      flag: 'r',
    });
  }
  catch (e) {
    return '';
  }
}

function resolveLocalFile(siteLocation, filePath) {
  if (typeof filePath !== 'string' || filePath === '') {
    return fallbackURL('');
  }
  if (
    filePath.indexOf('https://') === 0 ||
    filePath.indexOf('http://') === 0
  ) {
    try {
      return new URL(filePath);
    }
    catch (e) {
      return fallbackURL(filePath);
    }
  }
  const normalizedSiteLocation = cleanSiteLocation(siteLocation);
  if (normalizedSiteLocation === '') {
    return fallbackURL(filePath);
  }
  try {
    const tmp = new URL(normalizedSiteLocation);
    if (filePath[0] === '/') {
      return new URL(tmp.origin + filePath);
    }
    if (tmp.pathname === '/') {
      return new URL(tmp.origin + tmp.pathname + filePath);
    }
    return new URL(tmp.origin + tmp.pathname + '/' + filePath);
  }
  catch (e) {
    return fallbackURL(filePath);
  }
}

function typeFromElement(el) {
  if (!el || !el.tagName) {
    return 'other';
  }
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'audio':
    case 'audio-player':
      return 'audio';
    case 'video':
    case 'video-player':
    case 'a11y-media-player':
      return 'video';
    case 'embed':
    case 'object':
    case 'iframe': {
      const src = String(el.getAttribute('src') || '');
      const className = String(el.getAttribute('class') || '');
      if (
        src.indexOf('youtube.com') !== -1 ||
        src.indexOf('youtube-nocookie.com') !== -1 ||
        src.indexOf('vimeo.com') !== -1
      ) {
        return 'video';
      }
      if (
        className.indexOf('elmsmedia_h5p_content') !== -1 ||
        src.indexOf('h5p/embed') !== -1
      ) {
        return 'h5p';
      }
      return 'other';
    }
    case 'img':
    case 'simple-img':
    case 'media-image':
      return 'image';
    default:
      return 'other';
  }
}

function tracksValueHasSource(tracksValue) {
  if (typeof tracksValue !== 'string') {
    return false;
  }
  const normalized = tracksValue.trim();
  if (normalized === '') {
    return false;
  }
  const lower = normalized.toLowerCase();
  if (lower === 'null') {
    return false;
  }
  try {
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed)) {
      for (let i = 0; i < parsed.length; i++) {
        const track = parsed[i];
        if (typeof track === 'string' && track.trim() !== '') {
          return true;
        }
        if (
          track &&
          typeof track === 'object' &&
          typeof track.src === 'string' &&
          track.src.trim() !== ''
        ) {
          return true;
        }
      }
      return false;
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.src === 'string' &&
      parsed.src.trim() !== ''
    ) {
      return true;
    }
    return false;
  }
  catch (e) {
    if (normalized !== '[]' && normalized !== '{}') {
      return true;
    }
    return false;
  }
}

function hasVideoPlayerTranscript(el) {
  if (!el || !el.tagName || el.tagName.toLowerCase() !== 'video-player') {
    return true;
  }
  const trackValue = String(el.getAttribute('track') || '').trim();
  if (trackValue !== '' && trackValue.toLowerCase() !== 'null') {
    return true;
  }
  if (tracksValueHasSource(String(el.getAttribute('tracks') || ''))) {
    return true;
  }
  const trackNodes = el.querySelectorAll('track');
  if (trackNodes && trackNodes.length > 0) {
    return true;
  }
  return false;
}

function mediaStatus(item, el = null) {
  if (item.type === 'video' && !hasVideoPlayerTranscript(el)) {
    return 'warning';
  }
  switch (item.type) {
    case 'audio':
    case 'video':
    case 'other':
    case 'h5p':
      return 'info';
    case 'image':
      if (item.alt == null || item.alt === 'null') {
        return 'error';
      }
      if (item.name === item.alt || item.source === item.alt) {
        return 'error';
      }
      if (item.title === item.alt) {
        return 'error';
      }
      if (item.alt === '') {
        return 'warning';
      }
      if (item.alt && item.alt.indexOf('image') !== -1) {
        return 'warning';
      }
      if (item.alt && item.alt.indexOf('picture') !== -1) {
        return 'warning';
      }
      return 'info';
    default:
      return 'info';
  }
}

function YTDurationFormatConvert(input) {
  const reptms = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  let totalSeconds = 0;
  if (reptms.test(input)) {
    const matches = reptms.exec(input);
    if (matches && matches[1]) {
      hours = Number(matches[1]);
    }
    if (matches && matches[2]) {
      minutes = Number(matches[2]);
    }
    if (matches && matches[3]) {
      seconds = Number(matches[3]);
    }
    totalSeconds = hours * 3600 + minutes * 60 + seconds;
  }
  return totalSeconds;
}

async function getYoutubeDuration(vid) {
  if (!process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_API_KEY === '') {
    return 0;
  }
  let duration = 0;
  const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&key=${process.env.YOUTUBE_API_KEY}&id=${vid}`;
  let ytData = {};
  try {
    ytData = await fetch(url).then((d) => (d.ok ? d.json() : {}));
  }
  catch (e) {
    ytData = {};
  }
  if (ytData && Array.isArray(ytData.items)) {
    for (let i = 0; i < ytData.items.length; i++) {
      const item = ytData.items[i];
      if (item && item.contentDetails && item.contentDetails.duration) {
        duration += parseInt(
          YTDurationFormatConvert(item.contentDetails.duration),
          10
        );
      }
    }
  }
  return duration;
}

function getMediaSourceData(el, siteLocation) {
  if (!el) {
    return {
      urlData: fallbackURL(''),
      locType: 'external',
      source: 'unknown',
      name: 'unknown',
    };
  }
  let urlData = fallbackURL('');
  let locType = 'external';
  let source = 'unknown';
  let name = 'unknown';
  const sourceAttr = el.getAttribute('source');
  const srcAttr = el.getAttribute('src');
  if (sourceAttr) {
    if (
      sourceAttr.indexOf('https://') === 0 ||
      sourceAttr.indexOf('http://') === 0
    ) {
      try {
        urlData = new URL(sourceAttr);
      }
      catch (e) {
        urlData = fallbackURL(sourceAttr);
      }
    }
    else {
      urlData = resolveLocalFile(siteLocation, sourceAttr);
      locType = 'internal';
    }
  }
  else if (srcAttr) {
    if (srcAttr.indexOf('https://') === 0 || srcAttr.indexOf('http://') === 0) {
      try {
        urlData = new URL(srcAttr);
      }
      catch (e) {
        urlData = fallbackURL(srcAttr);
      }
    }
    else {
      urlData = resolveLocalFile(siteLocation, srcAttr);
      locType = 'internal';
    }
  }
  if (urlData && typeof urlData.toString === 'function') {
    source = urlData.toString();
  }
  if (urlData && urlData.pathname) {
    const pathParts = String(urlData.pathname).split('/');
    name = pathParts[pathParts.length - 1] || name;
  }
  return {
    urlData,
    locType,
    source,
    name,
  };
}

function getElementPageItemId(el) {
  let parent = el ? el.parentNode : null;
  while (parent && !parent.getAttribute('data-jos-item-id')) {
    parent = parent.parentNode;
  }
  if (parent && parent.getAttribute) {
    return parent.getAttribute('data-jos-item-id');
  }
  return null;
}

async function siteHTMLContent(
  siteLocation,
  siteData = null,
  ancestor = null,
  noTitles = false,
  textOnly = false
) {
  const site = await resolveSiteData(siteLocation, siteData);
  if (!site || !site.manifest) {
    return '';
  }
  let siteContent = '';
  const items = getBranchItems(site, ancestor);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) {
      continue;
    }
    if (!noTitles) {
      siteContent += `<h1>${item.title}</h1>`;
    }
    const content = await getItemHTML(site, item);
    siteContent += `<div data-jos-item-id="${item.id}">${content}</div>`;
  }
  if (textOnly) {
    const doc = parse(`<div id="wrapper">${siteContent}</div>`);
    const wrapper = doc.querySelector('#wrapper');
    if (wrapper) {
      siteContent = wrapper.innerText;
    }
    else {
      siteContent = doc.innerText;
    }
  }
  return siteContent;
}

async function courseStatsFromOutline(
  siteLocation,
  siteData = null,
  ancestor = null,
  dataInclude = null
) {
  const site = await resolveSiteData(siteLocation, siteData);
  if (!site || !site.manifest) {
    return {};
  }
  let items = [];
  if (ancestor != null) {
    items = getBranchItems(site, ancestor).filter(function (el) {
      if (el && el.metadata && el.metadata.published) {
        return true;
      }
      return false;
    });
  }
  else {
    items = getOrderedItems(site).filter(function (el) {
      if (el && el.metadata && el.metadata.published === false) {
        return false;
      }
      return true;
    });
  }
  const html = await siteHTMLContent(site, null, ancestor);
  const doc = parse(`<div id="wrapper">${html}</div>`);
  const data = {};
  if (dataInclude === null) {
    dataInclude = [
      'pages',
      'audio',
      'pageType',
      'selfChecks',
      'objectives',
      'authorNotes',
      'images',
      'h5p',
      'headings',
      'dataTables',
      'specialTags',
      'links',
      'placeholders',
      'siteremotecontent',
      'readTime',
      'video',
    ];
  }
  for (let i = 0; i < dataInclude.length; i++) {
    const inc = dataInclude[i];
    switch (inc) {
      case 'pages':
      case 'pageType':
        data[inc] = items.length;
        break;
      case 'audio':
        data[inc] = doc.querySelectorAll('audio,audio-player').length;
        break;
      case 'selfChecks':
        data[inc] = doc.querySelectorAll(
          'iframe.entity_iframe:not(.elmsmedia_h5p_content),self-check,multiple-choice'
        ).length;
        break;
      case 'h5p':
        data[inc] = doc.querySelectorAll(
          'iframe.elmsmedia_h5p_content,iframe[src*="h5p/embed"]'
        ).length;
        break;
      case 'objectives':
        data[inc] = doc.querySelectorAll(
          'instruction-card[type="objectives"] li'
        ).length;
        break;
      case 'authorNotes':
        data[inc] = doc.querySelectorAll('page-flag').length;
        break;
      case 'images':
        data[inc] = doc.querySelectorAll('media-image,img,simple-img').length;
        break;
      case 'headings':
        data[inc] = doc.querySelectorAll(
          'h1,h2,h3,h4,h5,h6,relative-heading'
        ).length;
        break;
      case 'dataTables':
        data[inc] = doc.querySelectorAll('table').length;
        break;
      case 'specialTags':
        data[inc] = doc.querySelectorAll(
          '*:not(p,div,h1,h2,h3,h4,h5,h6,table,bold,li,ul,ol,span,a,em,b,i,strike,u,code,pre,img,hr,tr,td,th)'
        ).length;
        break;
      case 'links':
        data[inc] = doc.querySelectorAll(
          'a[href^="http://"],a[href^="https://"]'
        ).length;
        break;
      case 'placeholders':
        data[inc] = doc.querySelectorAll('place-holder').length;
        break;
      case 'siteremotecontent':
        data[inc] = doc.querySelectorAll('site-remote-content').length;
        break;
      case 'readTime': {
        const wrapper = doc.querySelector('#wrapper');
        const text = wrapper ? wrapper.innerText : doc.innerText;
        data[inc] = Math.ceil(countWords(text) / WORDSPERMIN);
        break;
      }
      case 'video': {
        const videos = doc.querySelectorAll(
          'video-player,iframe[src*="youtube.com"],iframe[src*="youtube-nocookie.com"],iframe[src*="vimeo.com"],video[src],video source[src],a11y-media-player'
        );
        data[inc] = videos.length;
        data.videoLength = 0;
        const ytVids = [];
        let videoLength = 0;
        for (let v = 0; v < videos.length; v++) {
          const el = videos[v];
          const mediaData = getMediaSourceData(el, siteLocation);
          const urlData = mediaData.urlData;
          if (urlData && urlData.origin) {
            switch (urlData.origin) {
              case 'https://www.youtube-nocookie.com':
              case 'https://www.youtube.com': {
                if (urlData.searchParams && urlData.searchParams.get('v')) {
                  ytVids.push(urlData.searchParams.get('v'));
                }
                else if (
                  urlData.pathname &&
                  urlData.pathname.indexOf('/embed/') === 0
                ) {
                  ytVids.push(urlData.pathname.replace('/embed/', ''));
                }
                break;
              }
              case 'https://youtu.be':
                if (urlData.pathname) {
                  ytVids.push(urlData.pathname.replace('/', ''));
                }
                break;
              case 'https://vimeo.com':
              case 'https://player.vimeo.com': {
                let vimData = {};
                try {
                  const vimURL = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(
                    urlData.href
                  )}`;
                  vimData = await fetch(vimURL).then((d) =>
                    d.ok ? d.json() : {}
                  );
                }
                catch (e) {
                  vimData = {};
                }
                if (vimData && vimData.duration) {
                  videoLength += parseInt(vimData.duration, 10);
                }
                break;
              }
              default:
                break;
            }
          }
        }
        if (ytVids.length > 0) {
          let batch = [];
          for (let y = 0; y < ytVids.length; y++) {
            if (batch.length === 50) {
              videoLength += parseInt(
                await getYoutubeDuration(batch.join(',')),
                10
              );
              batch = [];
            }
            batch.push(ytVids[y]);
          }
          if (batch.length > 0) {
            videoLength += parseInt(await getYoutubeDuration(batch.join(',')), 10);
          }
        }
        data.videoLength = videoLength;
        break;
      }
      case 'linkData': {
        const extLinks = doc.querySelectorAll(
          'a[href^="http://"],a[href^="https://"]'
        );
        data.linkData = {};
        for (let l = 0; l < extLinks.length; l++) {
          const el = extLinks[l];
          const itemId = getElementPageItemId(el);
          const tmpItem = {
            linkTitle: el.innerText,
            itemId: itemId,
          };
          const href = el.getAttribute('href');
          if (!href) {
            continue;
          }
          if (data.linkData[href]) {
            data.linkData[href].push(tmpItem);
          }
          else {
            data.linkData[href] = [tmpItem];
          }
        }
        break;
      }
      case 'contentData': {
        data.contentData = [];
        const contentItems = doc.querySelectorAll('div[data-jos-item-id]');
        for (let c = 0; c < contentItems.length; c++) {
          const el = contentItems[c];
          const itemId = el.getAttribute('data-jos-item-id');
          const itemData = site.manifest.getItemById(itemId);
          if (itemData && itemData.id && itemData.metadata) {
            const itemSel = `div[data-jos-item-id="${itemData.id}"]`;
            const itemNode = doc.querySelector(itemSel);
            const words = itemNode ? countWords(itemNode.innerText) : 0;
            data.contentData.push({
              id: itemData.id,
              created: dateToISOTime(itemData.metadata.created),
              updated: dateToISOTime(itemData.metadata.updated),
              title: itemData.title,
              slug: itemData.slug,
              location: itemData.location,
              videos: doc.querySelectorAll(
                `${itemSel} video-player,${itemSel} iframe[src*="youtube.com"],${itemSel} iframe[src*="youtube-nocookie.com"],${itemSel} iframe[src*="vimeo.com"],${itemSel} video,${itemSel} a11y-media-player`
              ).length,
              audio: doc.querySelectorAll(`${itemSel} audio,${itemSel} audio-player`)
                .length,
              placeholders: doc.querySelectorAll(`${itemSel} place-holder`).length,
              siteremotecontent: doc.querySelectorAll(
                `${itemSel} site-remote-content`
              ).length,
              selfChecks: doc.querySelectorAll(
                `${itemSel} iframe.entity_iframe:not(.elmsmedia_h5p_content),${itemSel} self-check,${itemSel} multiple-choice`
              ).length,
              h5p: doc.querySelectorAll(
                `${itemSel} iframe.elmsmedia_h5p_content,${itemSel} iframe[src*="h5p/embed"]`
              ).length,
              objectives: doc.querySelectorAll(
                `${itemSel} instruction-card[type="objectives"] li`
              ).length,
              authorNotes: doc.querySelectorAll(`${itemSel} page-flag`).length,
              pageType:
                itemData.metadata && itemData.metadata.pageType
                  ? itemData.metadata.pageType
                  : '',
              images: doc.querySelectorAll(
                `${itemSel} media-image,${itemSel} img,${itemSel} simple-img`
              ).length,
              dataTables: doc.querySelectorAll(`${itemSel} table`).length,
              specialTags: doc.querySelectorAll(
                `${itemSel} *:not(p,div,h1,h2,h3,h4,h5,h6,table,bold,li,ul,ol,span,a,em,b,i,strike,u,code,pre,img,hr,tr,td,th)`
              ).length,
              links: doc.querySelectorAll(
                `${itemSel} a[href^="http://"],${itemSel} a[href^="https://"]`
              ).length,
              readTime: Math.ceil(words / WORDSPERMIN),
            });
          }
        }
        break;
      }
      case 'mediaData': {
        data.mediaData = [];
        const allMedia = doc.querySelectorAll(
          'audio[src],audio source[src],audio-player,video[src],video source[src],video-player,a11y-media-player,embed,object,iframe[src],media-image,img,simple-img,meme-maker'
        );
        for (let m = 0; m < allMedia.length; m++) {
          const el = allMedia[m];
          const mediaData = getMediaSourceData(el, siteLocation);
          let alt = el.getAttribute('alt');
          if (typeof alt === 'undefined') {
            alt = null;
          }
          let title = el.getAttribute('title');
          if (title == null && el.getAttribute('media-title')) {
            title = el.getAttribute('media-title');
          }
          const tmp = {
            source: mediaData.source,
            name: mediaData.name,
            alt: alt,
            title: title || null,
            locType: mediaData.locType,
            type: typeFromElement(el),
            itemId: getElementPageItemId(el),
          };
          tmp.status = mediaStatus(tmp, el);
          data.mediaData.push(tmp);
        }
        break;
      }
      default:
        break;
    }
  }
  return data;
}

module.exports = {
  resolveSiteData,
  courseStatsFromOutline,
  siteHTMLContent,
  resolveLocalFile,
  typeFromElement,
  mediaStatus,
  getYoutubeDuration,
  YTDurationFormatConvert,
};
