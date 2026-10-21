
# TaskFlow - To-Do List App

A simple task management application built for a Cloud Services project.

## Technologies

- Frontend: HTML, CSS, Bootstrap
- Backend: Python Flask REST API
- Database: PostgreSQL
- Containerization: Docker and Docker Compose

## Features

- Create, read, update, and delete tasks
- Mark tasks as completed
- Validate user input
- Health check endpoint
- Application logging
- Persistent PostgreSQL storage

## Requirements

- GitHub Codespaces or an environment with Docker Engine
- Docker Compose

## Setup

1. Clone the repository or open it in GitHub Codespaces.
2. Create the local environment file:

   ```bash
   cp .env.example .env
   ```

3. Build and start the services:

   ```bash
   docker compose up --build -d
   ```

4. Check the container status:

   ```bash
   docker compose ps
   ```

5. Open port 5000 in the Codespaces Ports tab.

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | /api/tasks | List tasks |
| POST | /api/tasks | Create a task |
| PUT | /api/tasks/{id} | Update a task |
| DELETE | /api/tasks/{id} | Delete a task |
| GET | /health | Check application and database health |

## Testing

Check application health:

```bash
curl http://localhost:5000/health
```

Create a task:

```bash
curl -X POST http://localhost:5000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Finish project","description":"Test Docker Compose"}'
```

List tasks:

```bash
curl http://localhost:5000/api/tasks
```

Test invalid input:

```bash
curl -i -X POST http://localhost:5000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":" "}'
```

The invalid input should return HTTP 400.

## Persistence Test

1. Create a task.
2. Restart the services:

   ```bash
   docker compose restart
   ```

3. Check the task list again. The task should remain stored.

Do not use `docker compose down -v` for this test because that command removes the database volume.

## Logs

```bash
docker compose logs -f
```

## Stop the Application

```bash
docker compose down
```

## Architecture

Browser -> Flask Web/API -> PostgreSQL

Docker Compose manages the web and database services.
The PostgreSQL named volume preserves data across container restarts.

## Contributions

Add each group member's name, assigned tasks, and completed contributions here.
