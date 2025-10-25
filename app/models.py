from datetime import datetime
from enum import Enum

from sqlalchemy import Column, DateTime, Enum as SqlEnum, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship

from app.database import Base


class HouseStatus(str, Enum):
    RED = "red"
    YELLOW = "yellow"
    GREEN = "green"


class House(Base):
    __tablename__ = "houses"

    id = Column(Integer, primary_key=True, index=True)
    address = Column(String(255), nullable=False)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    status = Column(SqlEnum(HouseStatus), default=HouseStatus.YELLOW, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    comments = relationship("Comment", back_populates="house", cascade="all, delete-orphan")

    def __repr__(self) -> str:  # pragma: no cover - debug helper
        return f"<House id={self.id} address={self.address!r} status={self.status}>"


class Comment(Base):
    __tablename__ = "comments"

    id = Column(Integer, primary_key=True, index=True)
    house_id = Column(Integer, ForeignKey("houses.id", ondelete="CASCADE"), nullable=False, index=True)
    text = Column(Text, nullable=False)
    author = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    house = relationship("House", back_populates="comments")

    def __repr__(self) -> str:  # pragma: no cover - debug helper
        return f"<Comment id={self.id} house_id={self.house_id} author={self.author!r}>"