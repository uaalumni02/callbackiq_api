import Db from '../../src/db/db.js';
test('identity lookup preserves exact OR query',async()=>{const model={findOne:jest.fn().mockResolvedValue({id:1})};await expect(Db.findUserByEmailOrUserName(model,'owner','a@example.com')).resolves.toEqual({id:1});expect(model.findOne).toHaveBeenCalledWith({$or:[{userName:'owner'},{email:'a@example.com'}]});});
test('saveUser preserves session option',async()=>{const save=jest.fn().mockResolvedValue('saved');const Model=jest.fn().mockImplementation(()=>({save}));await expect(Db.saveUser(Model,{a:1},{session:'session'})).resolves.toBe('saved');expect(save).toHaveBeenCalledWith({session:'session'});});
test('lookup excludes password',async()=>{const select=jest.fn().mockResolvedValue('owner');const model={findById:jest.fn().mockReturnValue({select})};await expect(Db.getUserById(model,'abc')).resolves.toBe('owner');expect(select).toHaveBeenCalledWith('-password');});
test('lookup failure keeps historical public error',async()=>{const model={findOne:jest.fn().mockRejectedValue(new Error('unavailable'))};await expect(Db.findUserByEmailOrUserName(model,'u','e')).rejects.toThrow('Database error while finding user');});
test('getUserById failure keeps historical public error',async()=>{const model={findById:jest.fn().mockReturnValue({select:jest.fn().mockRejectedValue(new Error('unavailable'))})};await expect(Db.getUserById(model,'x')).rejects.toThrow('Database error while fetching user');});
test('saveUser without a session passes undefined',async()=>{const save=jest.fn().mockResolvedValue('saved');const Model=jest.fn().mockImplementation(()=>({save}));await expect(Db.saveUser(Model,{a:1})).resolves.toBe('saved');expect(save).toHaveBeenCalledWith(undefined);});


test('stage3-coverage-save-rejection: preserves database save failures', async () => {
  const failure = Object.assign(
    new Error('Database write failed'),
    { code: 11000 }
  );

  const save = jest.fn().mockRejectedValue(failure);
  const Model = jest.fn().mockImplementation(() => ({ save }));

  const errorSpy = jest.spyOn(console, 'error')
    .mockImplementation(() => {});

  try {
    await expect(
      Db.saveUser(Model, { email: 'test@example.com' })
    ).rejects.toBe(failure);

    expect(save).toHaveBeenCalledWith(undefined);
  } finally {
    errorSpy.mockRestore();
  }
});
