# seed.py
from db import SessionLocal
from models import Profile, Meeting, Project
from sqlalchemy.exc import IntegrityError

profiles_payload = [
    {
        "name": "Mishal Ali",
        "email": "i221291@nu.edu.pk",
        "experience_years": 1,
        "role": "Frontend Developer",
        "skills": ["React", "Next.js", "Tailwind CSS", "UI/UX Design", "Responsive Design", "Basic Backend Integration", "ASR"],
        "strengths": ["Quick prototyping", "Attention to visual details", "Translating designs into clean code"],
        "current_projects": ["Building interactive dashboards", "Client-facing web applications"],
        "assigned_effort_points": 0
    },
    {
        "name": "Ayaan Mughal",
        "email": "i220861@nu.edu.pk",
        "experience_years": 3,
        "role": "Backend Developer",
        "skills": ["Node.js", "Python", "FastAPI", "PostgreSQL", "MongoDB", "REST & GraphQL API Development", "Server Optimization", "Docker", "AWS","Figma"],
        "strengths": ["Writing scalable backend systems", "Designing data pipelines", "Integrating ML services"],
        "current_projects": ["Maintaining API infrastructure", "Optimizing backend services for real-time applications"],
        "assigned_effort_points": 0
    },
    {
        "name": "Muaz Ahmed",
        "email": "i221125@nu.edu.pk",
        "experience_years": 2,
        "role": "Machine Learning Engineer",
        "skills": ["Python", "PyTorch", "TensorFlow", "NLP", "Computer Vision", "Speech Processing", "Testing" ,"Data Preprocessing", "Model Optimization", "GPU Acceleration", "End-to-End ML Pipelines"],
        "strengths": ["Applying ML to real-world problems", "Designing multimodal AI systems", "Mentoring juniors"],
        "current_projects": ["AI-driven meeting assistant", "Semantic search and recommendation systems"],
        "assigned_effort_points": 0
    }
]

def seed():
    session = SessionLocal()
    try:
        # Insert profiles
        created_profiles = []
        for p in profiles_payload:
            profile = Profile(
                name=p["name"],
                email=p.get("email"),
                experience_years=p.get("experience_years"),
                role=p.get("role"),
                skills=p.get("skills", []),
                strengths=p.get("strengths", []),
                current_projects=p.get("current_projects", []),
                assigned_effort_points=p.get("assigned_effort_points", 0)
            )
            session.add(profile)
            created_profiles.append(profile)

        session.commit()  # flush to get IDs
        # refresh to ensure ids
        for profile in created_profiles:
            session.refresh(profile)

        profile_ids = [p.id for p in created_profiles]
        print("Inserted profiles with IDs:", profile_ids)

        # Create a sample meeting with all participants
        meeting = Meeting(
            google_meet_id="meet-sample-001",
            transcript_path="/data/transcripts/meet-sample-001.txt",
            moms_path="/data/moms/meet-sample-001.md",
            participants=profile_ids
        )
        session.add(meeting)
        session.commit()
        session.refresh(meeting)
        print("Created meeting:", meeting.id)

        # Create a sample project
        project = Project(
            name="ScrumMate",
            sprints=6,
            user_stories_count=12,
            us_done=[],
            us_pending=[1,2,3,4,5],
            status="In Progress",
            trello_board_id="trello-board-123",
            team=profile_ids,
            meeting_id=meeting.id
        )
        session.add(project)
        session.commit()
        session.refresh(project)
        print("Created project:", project.id)

    except IntegrityError as e:
        session.rollback()
        print("IntegrityError (maybe ran seed twice) ->", e.orig)
    except Exception as e:
        session.rollback()
        print("Error seeding database:", str(e))
    finally:
        session.close()

if __name__ == "__main__":
    seed()
