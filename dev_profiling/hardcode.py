# seed_profiles.py
import sys
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from database.db import SessionLocal
from setup_profile import create_developer_profile

def main():
    db = SessionLocal()
    try:
        dev = create_developer_profile(
            db=db,
            name="Ayaan Mughal",
            email="ayaan@example.com",
            experience_years=2.5,
            role="Backend Engineer",
            skills=["Python", "FastAPI", "PostgreSQL", "SQLAlchemy"],
            strengths=["System design", "Debugging"],
            current_projects=["Meeting Master"]
        )

        print(f"✅ Developer profile created with ID: {dev.id}")

    finally:
        db.close()

if __name__ == "__main__":
    main()
