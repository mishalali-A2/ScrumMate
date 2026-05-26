-- Create Profile Table
CREATE TABLE profile (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE,
    experience_years NUMERIC(3,1),
    role VARCHAR(50),
    skills JSONB,
    strengths JSONB,
    current_projects JSONB,
    assigned_effort_points INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create Project Table
CREATE TABLE project (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    sprints INT,
    user_stories_count INT DEFAULT 0,
    us_done JSONB DEFAULT '[]',  -- Array of user story IDs/names
    us_pending JSONB DEFAULT '[]', -- Array of user story IDs
    status VARCHAR(50) DEFAULT 'Not Started',
    trello_board_id VARCHAR(100),
    team JSONB, -- Array of profile IDs
    meeting_id INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
);

-- Create Meetings Table
CREATE TABLE meetings (
    id SERIAL PRIMARY KEY,
    google_meet_id VARCHAR(100) UNIQUE,
    transcript_path TEXT,
    moms_path TEXT,
    participants JSONB, -- Array of profile IDs
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
