# cf-streamx
Build your own live m3u8 playlist with cloudflare worker and used iptv provider service as source (support:stalker portal, xtream code & ottclub) and used github private repository as hosted file for provider playlist. (For public repository worker check in folder public) 

> What's need? 
- GH_TOKEN : To access private repository file source, so created and generated token by your own at developer settings (e, g,: ghp_xdfvvghgfdfhjjnnsdf) 
- P1, P2.. : Playlist as source.(Need playlist source [CHECK](https://github.com/mrdnkl/stalker-xtream-m3u) how to grab it) 
- API_KEY : Just leave it to make playlist result in public download

> Deployment, 
- Forked this repository
- Go to your cloudflare account
- Create Application => Continue with github => Add github account => Select repository => Next => Create project name => Deploy! 
- After deployment sucsess go to worker setting to add variable (GH_TOKEN, P1..)
- DONE!

Test your cloudflare worker playlist download! 

> For all merged playlist download (P1, P2, etc) 
- cf-streamx.<your-own>.worker.dev/playlist.m3u
- 

> For single playlist download (P1, P2, etc) 
- cf-streamx.<your-own>.worker.dev/playlist_p1.m3u
- 

> If you need private download playlist just add new variable for API_KEY

cf-streamx.<your-own>.worker.dev/playlist_p1.m3u?key=whatever-your-API_KEY-setup


> Live m3u8 playlist.m3u output

#EXTM3U<br/>
#EXTINF:-1 tvg-id="" tvg-name="CH P1" tvg-logo="http://stalker/ch1.png" group-title="Stalker", CH P1
<br>https://cf-streamx.<yourown>.workers.dev/live/stream?id=p1_111111.m3u8</br>


#EXTINF:-1 tvg-id="" tvg-name="CH P2" tvg-logo="https://xtream/ch2.png" group-title="Xtream", CH P2
<br>https://cf-streamx.<yourown>.workers.dev/live/stream?id=p2_222222.m3u8</br>


#EXTINF:-1 tvg-id="" tvg-name="CH P3" tvg-logo="http://ottclub/ch3.png" group-title="Ottclub", CH P3
<br>https://cf-streamx.<yourown>.workers.dev/live/stream?id=p3_33333.m3u8</br>
