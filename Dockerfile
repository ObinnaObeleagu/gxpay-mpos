# Dspread CR100-SCRP web checkout + GxPay gateway integration.
# Runs the Express server (server.js) which serves the checkout UI from
# /public and exposes the /api/payments/* endpoints.
#
# NOTE: if your Render build fails with something like
#   "failed to calculate checksum of ref ...: '/public': not found"
# it means the `public/` folder isn't present in whatever Render is
# building from - almost always because it wasn't actually committed/pushed
# to the branch Render is deploying, or Render's "Root Directory" setting
# points somewhere else. See README-PAYMENT-INTEGRATION.md, "Troubleshooting
# Render deploys". This Dockerfile copies the whole build context (minus
# .dockerignore entries) rather than listing folders one by one, so once
# the files are actually present in the repo, this will pick them up.
FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Fail the build loudly (not just at request time) if the frontend didn't
# make it into the image, instead of shipping a server that 404s on every
# page.
RUN test -f public/checkout.html || (echo "ERROR: public/checkout.html not found in build context - see README-PAYMENT-INTEGRATION.md troubleshooting section" && exit 1)

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
