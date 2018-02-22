import { toPaddedBigInt, toReversePaddedBigInt } from './utils'
import { cloneForStorage } from './helpers'
import { dbPromise, getDatabase } from './databaseLifecycle'
import {
  accountsCache, deleteFromCache, getInCache, hasInCache, notificationsCache, setInCache,
  statusesCache
} from './cache'
import { scheduleCleanup } from './cleanup'
import {
  ACCOUNTS_STORE,
  NOTIFICATION_TIMELINES_STORE,
  NOTIFICATIONS_STORE, PINNED_STATUSES_STORE,
  STATUS_TIMELINES_STORE,
  STATUSES_STORE,
  ACCOUNT_ID,
  REBLOG_ID,
  STATUS_ID
} from './constants'

function createTimelineKeyRange (timeline, maxId) {
  let negBigInt = maxId && toReversePaddedBigInt(maxId)
  let start = negBigInt ? (timeline + '\u0000' + negBigInt) : (timeline + '\u0000')
  let end = timeline + '\u0000\uffff'
  return IDBKeyRange.bound(start, end, true, true)
}

// special case for threads – these are in chronological order rather than reverse
// chronological order, and we fetch everything all at once rather than paginating
function createKeyRangeForStatusThread (timeline) {
  let start = timeline + '\u0000'
  let end = timeline + '\u0000\uffff'
  return IDBKeyRange.bound(start, end, true, true)
}

function cacheStatus (status, instanceName) {
  setInCache(statusesCache, instanceName, status.id, status)
  setInCache(accountsCache, instanceName, status.account.id, status.account)
  if (status.reblog) {
    setInCache(accountsCache, instanceName, status.reblog.account.id, status.reblog.account)
  }
}

//
// pagination
//

async function getNotificationTimeline (instanceName, timeline, maxId, limit) {
  let storeNames = [NOTIFICATION_TIMELINES_STORE, NOTIFICATIONS_STORE, STATUSES_STORE, ACCOUNTS_STORE]
  const db = await getDatabase(instanceName)
  return dbPromise(db, storeNames, 'readonly', (stores, callback) => {
    let [ timelineStore, notificationsStore, statusesStore, accountsStore ] = stores
    let keyRange = createTimelineKeyRange(timeline, maxId)

    timelineStore.getAll(keyRange, limit).onsuccess = e => {
      let timelineResults = e.target.result
      let res = new Array(timelineResults.length)
      timelineResults.forEach((timelineResult, i) => {
        fetchNotification(notificationsStore, statusesStore, accountsStore, timelineResult.notificationId, notification => {
          res[i] = notification
        })
      })
      callback(res)
    }
  })
}

async function getStatusTimeline (instanceName, timeline, maxId, limit) {
  let storeNames = [STATUS_TIMELINES_STORE, STATUSES_STORE, ACCOUNTS_STORE]
  const db = await getDatabase(instanceName)
  return dbPromise(db, storeNames, 'readonly', (stores, callback) => {
    let [ timelineStore, statusesStore, accountsStore ] = stores
    // Status threads are a special case - these are in forward chronological order
    // and we fetch them all at once instead of paginating.
    let isStatusThread = timeline.startsWith('status/')
    let getReq = isStatusThread
      ? timelineStore.getAll(createKeyRangeForStatusThread(timeline))
      : timelineStore.getAll(createTimelineKeyRange(timeline, maxId), limit)

    getReq.onsuccess = e => {
      let timelineResults = e.target.result
      if (isStatusThread) {
        timelineResults = timelineResults.reverse()
      }
      let res = new Array(timelineResults.length)
      timelineResults.forEach((timelineResult, i) => {
        fetchStatus(statusesStore, accountsStore, timelineResult.statusId, status => {
          res[i] = status
        })
      })
      callback(res)
    }
  })
}

export async function getTimeline (instanceName, timeline, maxId = null, limit = 20) {
  return timeline === 'notifications'
    ? getNotificationTimeline(instanceName, timeline, maxId, limit)
    : getStatusTimeline(instanceName, timeline, maxId, limit)
}

//
// insertion
//

function putStatus (statusesStore, status) {
  statusesStore.put(cloneForStorage(status))
}

function putAccount (accountsStore, account) {
  accountsStore.put(cloneForStorage(account))
}

function putNotification (notificationsStore, notification) {
  notificationsStore.put(cloneForStorage(notification))
}

function storeAccount (accountsStore, account) {
  putAccount(accountsStore, account)
}

function storeStatus (statusesStore, accountsStore, status) {
  putStatus(statusesStore, status)
  putAccount(accountsStore, status.account)
  if (status.reblog) {
    putStatus(statusesStore, status.reblog)
    putAccount(accountsStore, status.reblog.account)
  }
}

function storeNotification (notificationsStore, statusesStore, accountsStore, notification) {
  if (notification.status) {
    storeStatus(statusesStore, accountsStore, notification.status)
  }
  storeAccount(accountsStore, notification.account)
  putNotification(notificationsStore, notification)
}

function fetchAccount (accountsStore, id, callback) {
  accountsStore.get(id).onsuccess = e => {
    callback(e.target.result)
  }
}

function fetchStatus (statusesStore, accountsStore, id, callback) {
  statusesStore.get(id).onsuccess = e => {
    let status = e.target.result
    callback(status)
    fetchAccount(accountsStore, status[ACCOUNT_ID], account => {
      status.account = account
    })
    if (status[REBLOG_ID]) {
      fetchStatus(statusesStore, accountsStore, status[REBLOG_ID], reblog => {
        status.reblog = reblog
      })
    }
  }
}

function fetchNotification (notificationsStore, statusesStore, accountsStore, id, callback) {
  notificationsStore.get(id).onsuccess = e => {
    let notification = e.target.result
    callback(notification)
    fetchAccount(accountsStore, notification[ACCOUNT_ID], account => {
      notification.account = account
    })
    if (notification[STATUS_ID]) {
      fetchStatus(statusesStore, accountsStore, notification[STATUS_ID], status => {
        notification.status = status
      })
    }
  }
}

function createTimelineId (timeline, id) {
  // reverse chronological order, prefixed by timeline
  return timeline + '\u0000' + toReversePaddedBigInt(id)
}

async function insertTimelineNotifications (instanceName, timeline, notifications) {
  /* no await */ scheduleCleanup()
  for (let notification of notifications) {
    setInCache(notificationsCache, instanceName, notification.id, notification)
    setInCache(accountsCache, instanceName, notification.account.id, notification.account)
    if (notification.status) {
      setInCache(statusesCache, instanceName, notification.status.id, notification.status)
    }
  }
  const db = await getDatabase(instanceName)
  let storeNames = [NOTIFICATION_TIMELINES_STORE, NOTIFICATIONS_STORE, ACCOUNTS_STORE, STATUSES_STORE]
  await dbPromise(db, storeNames, 'readwrite', (stores) => {
    let [ timelineStore, notificationsStore, accountsStore, statusesStore ] = stores
    for (let notification of notifications) {
      storeNotification(notificationsStore, statusesStore, accountsStore, notification)
      timelineStore.put({
        id: createTimelineId(timeline, notification.id),
        notificationId: notification.id
      })
    }
  })
}

async function insertTimelineStatuses (instanceName, timeline, statuses) {
  /* no await */ scheduleCleanup()
  for (let status of statuses) {
    cacheStatus(status, instanceName)
  }
  const db = await getDatabase(instanceName)
  let storeNames = [STATUS_TIMELINES_STORE, STATUSES_STORE, ACCOUNTS_STORE]
  await dbPromise(db, storeNames, 'readwrite', (stores) => {
    let [ timelineStore, statusesStore, accountsStore ] = stores
    for (let status of statuses) {
      storeStatus(statusesStore, accountsStore, status)
      timelineStore.put({
        id: createTimelineId(timeline, status.id),
        statusId: status.id
      })
    }
  })
}

export async function insertTimelineItems (instanceName, timeline, timelineItems) {
  return timeline === 'notifications'
    ? insertTimelineNotifications(instanceName, timeline, timelineItems)
    : insertTimelineStatuses(instanceName, timeline, timelineItems)
}

//
// get
//

export async function getStatus (instanceName, id) {
  if (hasInCache(statusesCache, instanceName, id)) {
    return getInCache(statusesCache, instanceName, id)
  }
  const db = await getDatabase(instanceName)
  let storeNames = [STATUSES_STORE, ACCOUNTS_STORE]
  let result = await dbPromise(db, storeNames, 'readonly', (stores, callback) => {
    let [ statusesStore, accountsStore ] = stores
    fetchStatus(statusesStore, accountsStore, id, callback)
  })
  setInCache(statusesCache, instanceName, id, result)
  return result
}

export async function getNotification (instanceName, id) {
  if (hasInCache(notificationsCache, instanceName, id)) {
    return getInCache(notificationsCache, instanceName, id)
  }
  const db = await getDatabase(instanceName)
  let storeNames = [NOTIFICATIONS_STORE, STATUSES_STORE, ACCOUNTS_STORE]
  let result = await dbPromise(db, storeNames, 'readonly', (stores, callback) => {
    let [ notificationsStore, statusesStore, accountsStore ] = stores
    fetchNotification(notificationsStore, statusesStore, accountsStore, id, callback)
  })
  setInCache(notificationsCache, instanceName, id, result)
  return result
}

//
// lookup by reblogs
//

export async function getReblogsForStatus (instanceName, id) {
  const db = await getDatabase(instanceName)
  await dbPromise(db, STATUSES_STORE, 'readonly', (statusesStore, callback) => {
    statusesStore.index(REBLOG_ID).getAll(IDBKeyRange.only(id)).onsuccess = e => {
      callback(e.target.result)
    }
  })
}

//
// deletes
//

export async function deleteStatusesAndNotifications (instanceName, statusIds, notificationIds) {
  for (let statusId of statusIds) {
    deleteFromCache(statusesCache, instanceName, statusId)
  }
  for (let notificationId of notificationIds) {
    deleteFromCache(notificationsCache, instanceName, notificationId)
  }
  const db = await getDatabase(instanceName)
  let storeNames = [
    STATUSES_STORE,
    STATUS_TIMELINES_STORE,
    NOTIFICATIONS_STORE,
    NOTIFICATION_TIMELINES_STORE,
    PINNED_STATUSES_STORE
  ]
  await dbPromise(db, storeNames, 'readwrite', (stores) => {
    let [
      statusesStore,
      statusTimelinesStore,
      notificationsStore,
      notificationTimelinesStore,
      pinnedStatusesStore
    ] = stores

    function deleteStatus (statusId) {
      pinnedStatusesStore.delete(statusId).onerror = e => {
        e.preventDefault()
        e.stopPropagation()
      }
      statusesStore.delete(statusId)
      let getAllReq = statusTimelinesStore.index('statusId')
        .getAllKeys(IDBKeyRange.only(statusId))
      getAllReq.onsuccess = e => {
        for (let result of e.target.result) {
          statusTimelinesStore.delete(result)
        }
      }
    }

    function deleteNotification (notificationId) {
      notificationsStore.delete(notificationId)
      let getAllReq = notificationTimelinesStore.index('statusId')
        .getAllKeys(IDBKeyRange.only(notificationId))
      getAllReq.onsuccess = e => {
        for (let result of e.target.result) {
          notificationTimelinesStore.delete(result)
        }
      }
    }

    for (let statusId of statusIds) {
      deleteStatus(statusId)
    }
    for (let notificationId of notificationIds) {
      deleteNotification(notificationId)
    }
  })
}

//
// pinned statuses
//

export async function insertPinnedStatuses (instanceName, accountId, statuses) {
  for (let status of statuses) {
    cacheStatus(status, instanceName)
  }
  const db = await getDatabase(instanceName)
  let storeNames = [PINNED_STATUSES_STORE, STATUSES_STORE, ACCOUNTS_STORE]
  await dbPromise(db, storeNames, 'readwrite', (stores) => {
    let [ pinnedStatusesStore, statusesStore, accountsStore ] = stores
    statuses.forEach((status, i) => {
      storeStatus(statusesStore, accountsStore, status)
      pinnedStatusesStore.put({
        id: accountId + '\u0000' + toPaddedBigInt(i),
        statusId: status.id
      })
    })
  })
}

export async function getPinnedStatuses (instanceName, accountId) {
  let storeNames = [PINNED_STATUSES_STORE, STATUSES_STORE, ACCOUNTS_STORE]
  const db = await getDatabase(instanceName)
  return dbPromise(db, storeNames, 'readonly', (stores, callback) => {
    let [ pinnedStatusesStore, statusesStore, accountsStore ] = stores
    let keyRange = IDBKeyRange.bound(
      accountId + '\u0000',
      accountId + '\u0000\uffff'
    )
    pinnedStatusesStore.getAll(keyRange).onsuccess = e => {
      let pinnedResults = e.target.result
      let res = new Array(pinnedResults.length)
      pinnedResults.forEach((pinnedResult, i) => {
        fetchStatus(statusesStore, accountsStore, pinnedResult.statusId, status => {
          res[i] = status
        })
      })
      callback(res)
    }
  })
}

//
// notifications by status
//

export async function getNotificationIdsForStatus (instanceName, statusId) {
  const db = await getDatabase(instanceName)
  return dbPromise(db, NOTIFICATIONS_STORE, 'readonly', (notificationStore, callback) => {
    notificationStore.index(statusId).getAllKeys(IDBKeyRange.only(statusId)).onsuccess = e => {
      callback(Array.from(e.target.result))
    }
  })
}