const fs = require('fs-extra')
const { escapeXMLValue } = require('./sanitizeContent.js')
// simple RSS / Atom feed generator from a JSON outline schema object
class FeedMe
{
    /**
     * Ensure a URL has a trailing slash if present.
     */
    ensureTrailingSlash(value = '')
    {
        if (!value) {
            return ''
        }
        if (value.substring(value.length - 1) !== '/') {
            return `${value}/`
        }
        return value
    }
    /**
     * Normalize timestamps that may be unix seconds or milliseconds.
     */
    normalizeTimestamp(value = null)
    {
        if (value === null || value === undefined || value === '') {
            return Date.now()
        }
        const numeric = Number(value)
        if (!isNaN(numeric)) {
            if (numeric < 1000000000000) {
                return numeric * 1000
            }
            return numeric
        }
        const parsed = Date.parse(value)
        if (!isNaN(parsed)) {
            return parsed
        }
        return Date.now()
    }
    /**
     * Escape values for XML output.
     */
    xmlEscape(value = '')
    {
        return escapeXMLValue(value)
    }
    /**
     * Convert rich HTML to plain text-ish output.
     */
    stripHTML(value = '')
    {
        return String(value)
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
    }
    /**
     * Safely read a page file's content based on item.location.
     */
    safeReadItemContent(site, item)
    {
        if (!site || !site.siteDirectory || !item || !item.location) {
            return ''
        }
        const safeLocation = String(item.location).replace(/\.\.\//g, '').replace(/\.\//g, '')
        try {
            return fs.readFileSync(
                `${site.siteDirectory}/${safeLocation}`,
                { encoding: 'utf8', flag: 'r' }
            )
        }
        catch (e) {
            return ''
        }
    }
    /**
     * Resolve item link, preferring slug and falling back to location.
     */
    getItemLink(item, domain)
    {
        let slug = ''
        if (item && item.slug) {
            slug = String(item.slug).replace(/^\/+/, '')
        }
        else if (item && item.location) {
            slug = String(item.location).replace('pages/', '').replace('/index.html', '').replace(/^\/+/, '')
        }
        return `${domain}${slug}`
    }
    /**
     * Generate the RSS 2.0 header.
     */
    getRSSFeed(site, domain = '')
    {
        if (!domain && site.manifest && site.manifest.metadata && site.manifest.metadata.site && site.manifest.metadata.site.domain) {
            domain = site.manifest.metadata.site.domain
        }
        domain = this.ensureTrailingSlash(domain)
        let updated = Math.floor(Date.now() / 1000)
        if (site.manifest && site.manifest.metadata && site.manifest.metadata.site && site.manifest.metadata.site.updated) {
            updated = site.manifest.metadata.site.updated
        }
        let title = ''
        if (site.manifest && site.manifest.title) {
            title = site.manifest.title
        }
        let description = ''
        if (site.manifest && site.manifest.description) {
            description = this.stripHTML(site.manifest.description)
        }
        let language = 'en-us'
        if (site && site.language) {
            language = site.language
        }
        let categories = ''
        if (site.manifest && site.manifest.metadata && site.manifest.metadata.tags && Array.isArray(site.manifest.metadata.tags)) {
            for (var key in site.manifest.metadata.tags) {
                let tag = String(site.manifest.metadata.tags[key]).trim()
                if (tag !== '') {
                    categories += `\n    <category>${this.xmlEscape(tag)}</category>`
                }
            }
        }
        let copyright = ''
        if (domain) {
            copyright = `\n    <copyright>Copyright (C) ${new Date().getFullYear()} ${this.xmlEscape(domain.replace(/\/$/, ''))}</copyright>`
        }
        return `<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:atom="http://www.w3.org/2005/Atom" version="2.0">
  <channel>
    <title>${this.xmlEscape(title)}</title>
    <link>${this.xmlEscape(domain)}</link>
    <description>${this.xmlEscape(description)}</description>${copyright}
    <language>${this.xmlEscape(language)}</language>
    <lastBuildDate>${new Date(this.normalizeTimestamp(updated)).toUTCString()}</lastBuildDate>
    <generator>HAXcms NodeJS</generator>${categories}
    <atom:link href="${this.xmlEscape(domain + 'rss.xml')}" rel="self" type="application/rss+xml"/>${this.rssItems(site, domain)}
  </channel>
</rss>`
    }
    /**
     * Generate RSS items.
     */
    rssItems(site, domain = '', limit = 25)
    {
        let output = ''
        domain = this.ensureTrailingSlash(domain)
        let count = 0
        let items = site.sortItems('created')
        for (var key in items) {
            let item = items[key]
            if (!item || typeof item !== 'object') {
                continue
            }
            // beyond edge but don't want this to erorr on write
            if (!(item.metadata) || typeof item.metadata !== 'object') {
              item.metadata = {}
            }
            if (!(item.metadata.created)) {
              item.metadata.created = Math.floor(Date.now() / 1000)
              item.metadata.updated = Math.floor(Date.now() / 1000)
            }
            if (count < limit) {
                let itemLink = this.getItemLink(item, domain)
                let categoryElements = ''
                if (item.metadata.tags && Array.isArray(item.metadata.tags)) {
                    for (var key2 in item.metadata.tags) {
                        let tag = String(item.metadata.tags[key2]).trim()
                        if (tag !== '') {
                            categoryElements += `\n      <category>${this.xmlEscape(tag)}</category>`
                        }
                    }
                }
                else if (item.metadata.tags && typeof item.metadata.tags === 'string') {
                    let tag = item.metadata.tags.trim()
                    if (tag !== '') {
                        categoryElements += `\n      <category>${this.xmlEscape(tag)}</category>`
                    }
                }
                let description = this.stripHTML(this.safeReadItemContent(site, item))
                if (description.length > 500) {
                    description = `${description.substring(0, 497)}...`
                }
                output += `
    <item>
      <title>${this.xmlEscape(item.title || '')}</title>
      <link>${this.xmlEscape(itemLink)}</link>
      <description>${this.xmlEscape(description)}</description>${categoryElements}
      <guid>${this.xmlEscape(itemLink)}</guid>
      <pubDate>${new Date(this.normalizeTimestamp(item.metadata.created)).toUTCString()}</pubDate>
    </item>`
            }
            count++
        }
        return output
    }
    /**
     * Generate the atom feed.
     */
    getAtomFeed(site, domain = '')
    {
        if (!domain && site.manifest && site.manifest.metadata && site.manifest.metadata.site && site.manifest.metadata.site.domain) {
            domain = site.manifest.metadata.site.domain
        }
        domain = this.ensureTrailingSlash(domain)
        let updated = Math.floor(Date.now() / 1000)
        if (site.manifest && site.manifest.metadata && site.manifest.metadata.site && site.manifest.metadata.site.updated) {
            updated = site.manifest.metadata.site.updated
        }
        let title = ''
        if (site.manifest && site.manifest.title) {
            title = site.manifest.title
        }
        let subtitle = ''
        if (site.manifest && site.manifest.description) {
            subtitle = site.manifest.description
        }
        let author = ''
        if (site.manifest && site.manifest.author) {
            author = site.manifest.author
        }
        else if (site.manifest && site.manifest.metadata && site.manifest.metadata.author && site.manifest.metadata.author.name) {
            author = site.manifest.metadata.author.name
        }
        return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${this.xmlEscape(title)}</title>
  <link href="${this.xmlEscape(domain)}" rel="self" />
  <subtitle>${this.xmlEscape(subtitle)}</subtitle>
  <updated>${new Date(this.normalizeTimestamp(updated)).toISOString()}</updated>
  <author>
      <name>${this.xmlEscape(author)}</name>
  </author>
  <id>${this.xmlEscape(domain)}</id>
  ${this.atomItems(site, domain)}
</feed>`
    }
    /**
     * Generate Atom items.
     */
    atomItems(site, domain = '', limit = 25)
    {
        let output = ''
        domain = this.ensureTrailingSlash(domain)
        let count = 0
        let items = site.sortItems('created')
        for (var key in items) {
            let item = items[key]
            if (!item || typeof item !== 'object') {
                continue
            }
            let tags = ''
            // beyond edge but don't want this to erorr on write
            if (!(item.metadata) || typeof item.metadata !== 'object') {
              item.metadata = {}
            }
            if (!(item.metadata.created)) {
              item.metadata.created = Math.floor(Date.now() / 1000)
              item.metadata.updated = Math.floor(Date.now() / 1000)
            }
            if ((item.metadata.tags)) {
                if (Array.isArray(item.metadata.tags)) {
                    for (var key2 in item.metadata.tags) {
                        let tag = String(item.metadata.tags[key2]).trim()
                        if (tag !== '') {
                            tags += '<category term="' + this.xmlEscape(tag) + '" label="' + this.xmlEscape(tag) + '" />'
                        }
                    }
                }
                else if (typeof item.metadata.tags === 'string' && item.metadata.tags.trim() !== '') {
                    let tag = item.metadata.tags.trim()
                    tags += '<category term="' + this.xmlEscape(tag) + '" label="' + this.xmlEscape(tag) + '" />'
                }
            }
            if (count < limit) {
                let itemLink = this.getItemLink(item, domain)
                let itemId = item.id || itemLink
                let itemContent = this.safeReadItemContent(site, item).replace(/\]\]>/g, ']]]]><![CDATA[>')
                output += `
  <entry>
    <title>${this.xmlEscape(item.title || '')}</title>
    <id>${this.xmlEscape(itemId)}</id>
    <updated>${new Date(this.normalizeTimestamp(item.metadata.updated)).toISOString()}</updated>
    <published>${new Date(this.normalizeTimestamp(item.metadata.created)).toISOString()}</published>
    <summary>${this.xmlEscape(item.description || '')}</summary>
    <link href="${this.xmlEscape(itemLink)}"/>
    ${tags}
    <content type="html">
      <![CDATA[ ${itemContent} ]]>
    </content>
  </entry>`
            }
            count++
        }
        return output
    }
    /**
     * Generate a sitemap.xml file.
     */
    getSitemap(site, domain = '')
    {
        if (!domain && site.manifest && site.manifest.metadata && site.manifest.metadata.site && site.manifest.metadata.site.domain) {
            domain = site.manifest.metadata.site.domain
        }
        domain = this.ensureTrailingSlash(domain)
        return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${this.sitemapItems(site, domain)}\n</urlset>`
    }
    /**
     * Generate sitemap items.
     */
    sitemapItems(site, domain = '')
    {
        let output = ''
        domain = this.ensureTrailingSlash(domain)
        let items = site.sortItems('created')
        for (var key in items) {
            let item = items[key]
            if (!item) {
                continue
            }
            let priority = '0.5'
            if (item.parent == null) {
                priority = '1.0'
            }
            else if (item.indent == 2) {
                priority = '0.7'
            }
            let updated = Date.now()
            if (item.metadata && item.metadata.updated) {
                updated = item.metadata.updated
            }
            let itemLink = this.getItemLink(item, domain)
            output += `\n  <url>\n    <loc>${this.xmlEscape(itemLink)}</loc>\n    <lastmod>${new Date(this.normalizeTimestamp(updated)).toISOString()}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>${priority}</priority>\n  </url>`
        }
        return output
    }
    /**
     * Generate a sitemap-index.xml file.
     */
    getSitemapIndex(domain = '')
    {
        domain = this.ensureTrailingSlash(domain)
        return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <sitemap>\n    <loc>${this.xmlEscape(domain + 'sitemap.xml')}</loc>\n    <lastmod>${new Date().toISOString()}</lastmod>\n  </sitemap>\n</sitemapindex>`
    }
}
module.exports = FeedMe
