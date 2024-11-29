# Use an official Node.js runtime as the base image
FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json to leverage Docker cache
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application code
COPY . .

# Expose the port your application runs on (if applicable)
# Uncomment and set the correct port if your app listens on a specific port
# EXPOSE 3000

# Specify the command to run your application
CMD ["node", "emailgend.js"]
