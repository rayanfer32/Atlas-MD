## deploy new changes and restart the bot

(cd ~/bots/Atlas-MD; git pull && bun install && pm2 restart Atlas --update-env)