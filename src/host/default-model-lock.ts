import type { ModelSelection } from '../shared/model.ts'

interface DefaultModelService {
  currentSelection(): ModelSelection
  saveSelection(selection: ModelSelection): Promise<void>
}

/** 宿主分别读取默认值和写回选择。只在锁定期间替换默认行为。 */
export function installDefaultModelLock(service: DefaultModelService, getLockedSelection: () => ModelSelection | undefined): () => void {
  const { currentSelection, saveSelection } = service
  if (typeof currentSelection !== 'function' || typeof saveSelection !== 'function') throw new TypeError('宿主默认模型接口不可用')
  const originalRead = Object.getOwnPropertyDescriptor(service, 'currentSelection')
  const originalSave = Object.getOwnPropertyDescriptor(service, 'saveSelection')
  const read = function (this: DefaultModelService) {
    const locked = getLockedSelection()
    return locked ? { ...locked } : currentSelection.call(this)
  }
  const save = async function (this: DefaultModelService, selection: ModelSelection) {
    if (!getLockedSelection()) await saveSelection.call(this, selection)
  }
  const restore = (name: keyof DefaultModelService, wrapper: Function, original?: PropertyDescriptor) => {
    if (Object.getOwnPropertyDescriptor(service, name)?.value !== wrapper) return
    if (original) Object.defineProperty(service, name, original)
    else Reflect.deleteProperty(service, name)
  }
  const dispose = () => {
    restore('saveSelection', save, originalSave)
    restore('currentSelection', read, originalRead)
  }
  try {
    Object.defineProperties(service, {
      currentSelection: { value: read, writable: true, configurable: true },
      saveSelection: { value: save, writable: true, configurable: true },
    })
  } catch (error) {
    dispose()
    throw error
  }
  return dispose
}
