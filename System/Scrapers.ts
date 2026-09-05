import axios from "axios";
import { load as cheerioLoad } from "cheerio";

const cheerio = { load: cheerioLoad };

export interface WallpaperResult {
  title: string;
  type: string;
  source: string;
  image: (string | undefined)[];
}

export interface RingtoneResult {
  title: string;
  source: string;
  audio: string | undefined;
}

export async function wallpaper(title: string, page = "1"): Promise<WallpaperResult[]> {
  const { data } = await axios.get(
    `https://www.besthdwallpaper.com/search?CurrentPage=${page}&q=${encodeURIComponent(title)}`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    }
  );
  const $ = cheerio.load(data);
  const fetchedresult: WallpaperResult[] = [];
  $("div.grid-item").each(function (_a, b) {
    fetchedresult.push({
      title: $(b).find("div.info > a > h3").text(),
      type: $(b).find("div.info > a:nth-child(2)").text(),
      source: "https://www.besthdwallpaper.com/" + $(b).find("div > a:nth-child(3)").attr("href"),
      image: [
        $(b).find("picture > img").attr("data-src") ||
          $(b).find("picture > img").attr("src"),
        $(b).find("picture > source:nth-child(1)").attr("srcset"),
        $(b).find("picture > source:nth-child(2)").attr("srcset"),
      ],
    });
  });
  return fetchedresult;
}

export async function ringtone(title: string): Promise<RingtoneResult[]> {
  const { data } = await axios.get(
    "https://meloboom.com/en/search/" + encodeURIComponent(title)
  );
  const $ = cheerio.load(data);
  const fetchedresult: RingtoneResult[] = [];
  $(
    "#__next > main > section > div.jsx-2244708474.container > div > div > div > div:nth-child(4) > div > div > div > ul > li"
  ).each(function (_a, b) {
    fetchedresult.push({
      title: $(b).find("h4").text(),
      source: "https://meloboom.com/" + $(b).find("a").attr("href"),
      audio: $(b).find("audio").attr("src"),
    });
  });
  return fetchedresult;
}

export default { wallpaper, ringtone };
