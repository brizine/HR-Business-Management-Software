"use client";
import { LabeledSelect, MenuSelect, useMenus } from "./menu-select";

export function AssetFields({ initial = {} as any, employees = [] as any[] }) {
  const menus = useMenus();
  return (
    <div className="formgrid">
      <label>Name<input name="name" defaultValue={initial.name} required placeholder="Truck 12" /></label>
      <MenuSelect name="type" label="Type" options={menus.assetTypes} current={initial.type ?? menus.assetTypes[0]} blank={false} required />
      <label>Make<input name="make" defaultValue={initial.make ?? ""} /></label>
      <label>Model<input name="model" defaultValue={initial.model ?? ""} /></label>
      <label>Year<input name="year" type="number" defaultValue={initial.year ?? ""} /></label>
      <label>VIN<input name="vin" defaultValue={initial.vin ?? ""} /></label>
      <label>Serial number<input name="serialNumber" defaultValue={initial.serialNumber ?? ""} /></label>
      <label>License plate<input name="licensePlate" defaultValue={initial.licensePlate ?? ""} /></label>
      <label>Odometer (mi)<input name="odometer" type="number" min="0" defaultValue={initial.odometer ?? 0} /></label>
      <label>Engine hours<input name="engineHours" type="number" min="0" step="0.1" defaultValue={initial.engineHours ?? 0} /></label>
      <label>Status
        <LabeledSelect menu="assetStatus" values={["active", "in_shop", "out_of_service", "retired"]} name="status" defaultValue={initial.status ?? "active"} />
      </label>
      <label>Assigned to
        <select name="assignedEmployeeId" defaultValue={initial.assignedEmployeeId ?? ""}>
          <option value="">—</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
        </select>
      </label>
      <label>Registration expires<input name="registrationExpires" type="date" defaultValue={initial.registrationExpires ?? ""} /></label>
      <label>Insurance expires<input name="insuranceExpires" type="date" defaultValue={initial.insuranceExpires ?? ""} /></label>
    </div>
  );
}
