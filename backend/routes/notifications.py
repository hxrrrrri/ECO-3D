from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import or_
from typing import List
import uuid

from database.session import get_db
from database.models import Notification
from models.schemas import NotificationResponse

router = APIRouter(prefix="/notifications", tags=["Notifications"])

@router.get("", response_model=List[NotificationResponse])
async def get_notifications(user_id: str = None, db: AsyncSession = Depends(get_db)):
    """
    Fetch notifications. Currently, it accepts an optional user_id (since we don't have
    a forced JWT verification middleware in this example, we pass it via query).
    If no user_id is provided, it returns global notifications.
    """
    stmt = select(Notification).order_by(Notification.created_at.desc())
    if user_id:
        try:
            uid = uuid.UUID(user_id)
            stmt = stmt.where(or_(Notification.user_id == uid, Notification.user_id == None))
        except ValueError:
            stmt = stmt.where(Notification.user_id == None)
    else:
        stmt = stmt.where(Notification.user_id == None)
        
    result = await db.execute(stmt)
    notifications = result.scalars().all()
    
    # Auto-seed a welcome notification if empty
    if not notifications:
        welcome_note = Notification(
            title="System Initialization",
            message="Welcome to ECO-3D globally distributed intelligence network. Bio-Integrity check passed.",
            type="success",
            user_id=uuid.UUID(user_id) if user_id else None
        )
        db.add(welcome_note)
        await db.commit()
        await db.refresh(welcome_note)
        return [welcome_note]
        
    return notifications

@router.post("/{notification_id}/read")
async def mark_as_read(notification_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Notification).where(Notification.id == uuid.UUID(notification_id)))
    notif = result.scalars().first()
    
    if not notif:
        raise HTTPException(status_code=404, detail="Notification not found")
        
    notif.is_read = True
    await db.commit()
    return {"status": "ok"}
