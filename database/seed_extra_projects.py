"""
Add 2 more sample projects so the dropdown has realistic content.
"""
from db import SessionLocal
from models import Profile, Meeting, Project

session = SessionLocal()
try:
    profile_ids = [p.id for p in session.query(Profile).all()]
    print("Profile IDs:", profile_ids)

    projects = [
        Project(
            name="AI Recommendation Engine",
            sprints=4,
            user_stories_count=8,
            us_done=[1, 2],
            us_pending=[3, 4, 5],
            status="In Progress",
            team=profile_ids,
        ),
        Project(
            name="Mobile Companion App",
            sprints=3,
            user_stories_count=6,
            us_done=[],
            us_pending=[1, 2, 3, 4, 5, 6],
            status="Not Started",
            team=profile_ids,
        ),
    ]
    for p in projects:
        session.add(p)
    session.commit()
    for p in projects:
        session.refresh(p)
        print(f"Created project: id={p.id} name={p.name!r}")
finally:
    session.close()
