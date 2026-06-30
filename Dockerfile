# Dockerfile — builds a minimal Node.js image for the PlantSim PoC
# Base: node:22-alpine (small, fast to pull)

FROM node:22-alpine

WORKDIR /app

# Copy dependency manifest first so Docker can cache the npm install layer
COPY package.json ./

# Install production dependencies only (no devDependencies, no postinstall scripts)
RUN npm install --omit=dev

# Copy the application source
COPY src/ ./src/

# Expose the HTTP port (matches PORT env var default in server.js) and OPC UA port
EXPOSE 3000 4840

# Start the server
CMD ["node", "src/server.js"]
