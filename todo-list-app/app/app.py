
import logging
import os
import time

from flask import Flask, jsonify, render_template, request
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

app = Flask(__name__)

app.config["SQLALCHEMY_DATABASE_URI"] = os.getenv(
    "DATABASE_URL",
    "postgresql://todo_user:change_this_local_password@db:5432/todo_db"
)
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db = SQLAlchemy(app)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s"
)
logger = logging.getLogger(__name__)


class Task(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(120), nullable=False)
    description = db.Column(db.String(500), nullable=False, default="")
    completed = db.Column(db.Boolean, nullable=False, default=False)

    def to_dict(self):
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "completed": self.completed
        }


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/health")
def health():
    try:
        db.session.execute(text("SELECT 1"))
        return jsonify({"status": "healthy", "database": "connected"}), 200
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Health check failed")
        return jsonify({"status": "unhealthy", "database": "disconnected"}), 503


@app.get("/api/tasks")
def get_tasks():
    tasks = db.session.execute(
        db.select(Task).order_by(Task.id.desc())
    ).scalars().all()

    return jsonify([task.to_dict() for task in tasks]), 200


@app.post("/api/tasks")
def create_task():
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"error": "Request body must be valid JSON"}), 400

    title = data.get("title")
    description = data.get("description", "")

    if not isinstance(title, str) or not title.strip():
        return jsonify({"error": "Title is required"}), 400

    if len(title.strip()) > 120:
        return jsonify({"error": "Title must be at most 120 characters"}), 400

    if not isinstance(description, str):
        return jsonify({"error": "Description must be text"}), 400

    if len(description) > 500:
        return jsonify({"error": "Description must be at most 500 characters"}), 400

    task = Task(
        title=title.strip(),
        description=description.strip()
    )

    try:
        db.session.add(task)
        db.session.commit()
        logger.info("Created task id=%s", task.id)
        return jsonify(task.to_dict()), 201
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Failed to create task")
        return jsonify({"error": "Unable to save task"}), 500


@app.put("/api/tasks/<int:task_id>")
def update_task(task_id):
    task = db.session.get(Task, task_id)

    if task is None:
        return jsonify({"error": "Task not found"}), 404

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"error": "Request body must be valid JSON"}), 400

    if "title" in data:
        title = data["title"]
        if not isinstance(title, str) or not title.strip():
            return jsonify({"error": "Title cannot be empty"}), 400
        if len(title.strip()) > 120:
            return jsonify({"error": "Title must be at most 120 characters"}), 400
        task.title = title.strip()

    if "description" in data:
        description = data["description"]
        if not isinstance(description, str):
            return jsonify({"error": "Description must be text"}), 400
        if len(description) > 500:
            return jsonify({"error": "Description must be at most 500 characters"}), 400
        task.description = description.strip()

    if "completed" in data:
        if not isinstance(data["completed"], bool):
            return jsonify({"error": "Completed must be true or false"}), 400
        task.completed = data["completed"]

    try:
        db.session.commit()
        logger.info("Updated task id=%s", task.id)
        return jsonify(task.to_dict()), 200
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Failed to update task")
        return jsonify({"error": "Unable to update task"}), 500


@app.delete("/api/tasks/<int:task_id>")
def delete_task(task_id):
    task = db.session.get(Task, task_id)

    if task is None:
        return jsonify({"error": "Task not found"}), 404

    try:
        db.session.delete(task)
        db.session.commit()
        logger.info("Deleted task id=%s", task_id)
        return jsonify({"message": "Task deleted successfully"}), 200
    except SQLAlchemyError:
        db.session.rollback()
        logger.exception("Failed to delete task")
        return jsonify({"error": "Unable to delete task"}), 500


if __name__ == "__main__":
    with app.app_context():
        for attempt in range(10):
            try:
                db.create_all()
                logger.info("Database tables are ready")
                break
            except SQLAlchemyError:
                db.session.rollback()
                if attempt == 9:
                    raise
                logger.warning("Database unavailable; retrying...")
                time.sleep(3)

    app.run(host="0.0.0.0", port=5000, debug=False)
