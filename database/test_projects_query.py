"""
Test query: fetch all projects whose team includes the currently logged-in user.
The 'logged-in user' is identified by email (Muaz Ahmed in our seed).
Run from the database/ folder:  python test_projects_query.py
"""
from db import SessionLocal
from models import Profile, Project
from sqlalchemy import cast, Integer
from sqlalchemy.dialects.postgresql import JSONB
import json

USER_EMAIL = "i221125@nu.edu.pk"   # Muaz Ahmed

session = SessionLocal()
try:
    # 1. Find the user's profile id
    profile = session.query(Profile).filter(Profile.email == USER_EMAIL).first()
    if not profile:
        print(f"[!] No profile found for {USER_EMAIL}")
    else:
        print(f"[+] Found profile: id={profile.id}, name={profile.name}")

        # 2. Find all projects where team JSONB array contains this profile id
        #    team is stored as JSONB array of ints, e.g. [1, 2, 3]
        projects = (
            session.query(Project)
            .filter(Project.team.contains(cast([profile.id], JSONB)))
            .order_by(Project.created_at.desc())
            .all()
        )

        print(f"\n[+] Projects for {profile.name}: {len(projects)} found")
        for p in projects:
            print(f"    id={p.id}  name={p.name!r}  status={p.status!r}  sprints={p.sprints}")

    # 3. Also show ALL projects so we know what's in the DB
    all_projects = session.query(Project).all()
    print(f"\n[+] ALL projects in DB: {len(all_projects)}")
    for p in all_projects:
        print(f"    id={p.id}  name={p.name!r}  status={p.status!r}  team={p.team}")

finally:
    session.close()
