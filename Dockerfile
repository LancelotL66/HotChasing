# Build stage
FROM node:22-alpine AS build

WORKDIR /app

# Copy package files
COPY package*.json ./

# node-pty is optional for the web app but present for the Windows local Runner.
# Keep other optional platform bindings required by Vite/Rolldown available.
RUN apk add --no-cache python3 make g++ && npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM nginx:alpine

# Remove default nginx config that conflicts with ours
RUN rm -f /etc/nginx/conf.d/default.conf

# Copy built files from build stage
COPY --from=build /app/dist /usr/share/nginx/html

# Copy custom nginx configuration template (rendered at startup with BACKEND_HOST)
COPY nginx.conf.template /etc/nginx/nginx.conf.template

# Expose port
EXPOSE 80

# Render the nginx config (substituting BACKEND_HOST and RESOLVER) and start nginx
CMD ["sh", "-c", "export BACKEND_HOST=${BACKEND_HOST:-backend:3000}; export RESOLVER=${RESOLVER:-127.0.0.11}; envsubst '${BACKEND_HOST} ${RESOLVER}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf && nginx -g 'daemon off;'"]
