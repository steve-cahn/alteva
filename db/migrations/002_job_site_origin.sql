-- The origin the site is actually served from, learned when the start page is fetched: the start
-- URL may redirect (http -> https, example.com -> www.example.com, or to another domain). Internal
-- links are canonicalized to it so one page is never stored under several spellings. NULL until the
-- start page has been processed; readers fall back to the origin of jobs.url.
ALTER TABLE jobs ADD COLUMN site_origin text;
