# models.py
from sqlalchemy import Column, Integer, String, Float, ForeignKey, TIMESTAMP, func
from sqlalchemy.orm import relationship, declarative_base
from sqlalchemy.dialects.postgresql import JSONB

Base = declarative_base()

class Profile(Base):
    __tablename__ = "profile"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), nullable=False)
    email = Column(String(200), unique=True, nullable=True)
    experience_years = Column(Float, nullable=True)
    role = Column(String(100), nullable=True)
    skills = Column(JSONB, nullable=False, default=list)              # list of strings
    strengths = Column(JSONB, nullable=False, default=list)           # list of strings
    current_projects = Column(JSONB, nullable=False, default=list)    # list of strings
    assigned_effort_points = Column(Integer, nullable=False, default=0)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())

    def __repr__(self):
        return f"<Profile id={self.id} name={self.name}>"

class Meeting(Base):
    __tablename__ = "meetings"
    id = Column(Integer, primary_key=True, index=True)
    google_meet_id = Column(String(200), unique=True, nullable=True)
    transcript_path = Column(String, nullable=True)
    moms_path = Column(String, nullable=True)
    participants = Column(JSONB, nullable=False, default=list)  # list of profile ids
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())

    def __repr__(self):
        return f"<Meeting id={self.id} google_meet_id={self.google_meet_id}>"

class Project(Base):
    __tablename__ = "project"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), nullable=False)
    sprints = Column(Integer, nullable=True)
    user_stories_count = Column(Integer, nullable=False, default=0)
    us_done = Column(JSONB, nullable=False, default=list)     # array of user story identifiers or objects
    us_pending = Column(JSONB, nullable=False, default=list)  # array of IDs
    status = Column(String(100), nullable=False, default="Not Started")
    trello_board_id = Column(String(200), nullable=True)
    team = Column(JSONB, nullable=False, default=list)       # array of profile ids
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=True)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())

    meeting = relationship("Meeting", backref="projects", lazy="joined")

    def __repr__(self):
        return f"<Project id={self.id} name={self.name}>"
