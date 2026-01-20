# profile_service.py
from sqlalchemy.orm import Session
from database.models import Profile

def create_developer_profile(
    db: Session,
    name: str,
    email: str | None = None,
    experience_years: float | None = None,
    role: str | None = None,
    skills: list[str] | None = None,
    strengths: list[str] | None = None,
    current_projects: list[str] | None = None
) -> Profile:
    profile = Profile(
        name=name,
        email=email,
        experience_years=experience_years,
        role=role,
        skills=skills or [],
        strengths=strengths or [],
        current_projects=current_projects or [],
        assigned_effort_points=0
    )

    db.add(profile)
    db.commit()
    db.refresh(profile)

    return profile
