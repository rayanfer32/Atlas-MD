import corePlugin from "../../Plugins/core.js";
import downloaderPlugin from "../../Plugins/downloader.js";
import githubProjectsPlugin from "../../Plugins/githubProjects.js";
import groupPlugin from "../../Plugins/group.js";
import jimmyPlugin from "../../Plugins/jimmy.js";
import kamavoDailyWinsPlugin from "../../Plugins/kamavo-daily-wins.js";
import moderatorPlugin from "../../Plugins/moderator.js";
import pluginPlugin from "../../Plugins/plugin.js";
import revivePlugin from "../../Plugins/revive.js";
import searchPlugin from "../../Plugins/search.js";
import toolsPlugin from "../../Plugins/tools.js";
import youtubeDlPlugin from "../../Plugins/youtube-dl.js";
import type { Plugin } from "../../core/plugin.js";

export const defaultPlugins: Plugin[] = [
  corePlugin as Plugin,
  downloaderPlugin as Plugin,
  githubProjectsPlugin as Plugin,
  groupPlugin as Plugin,
  jimmyPlugin as Plugin,
  kamavoDailyWinsPlugin as Plugin,
  moderatorPlugin as Plugin,
  pluginPlugin as Plugin,
  revivePlugin as Plugin,
  searchPlugin as Plugin,
  toolsPlugin as Plugin,
  youtubeDlPlugin as Plugin,
];

export {
  corePlugin,
  downloaderPlugin,
  githubProjectsPlugin,
  groupPlugin,
  jimmyPlugin,
  kamavoDailyWinsPlugin,
  moderatorPlugin,
  pluginPlugin,
  revivePlugin,
  searchPlugin,
  toolsPlugin,
  youtubeDlPlugin,
};

export default defaultPlugins;
